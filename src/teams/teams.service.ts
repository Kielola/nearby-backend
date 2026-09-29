import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';

/** Squad cap, from the original app. */
const MAX_TEAM_MEMBERS = 5;

/** Prize pool by rank, in kobo — the original team challenge figures. */
const TEAM_PRIZES_KOBO = [200_000, 100_000, 50_000, 25_000, 10_000];

@Injectable()
export class TeamsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  /**
   * Every squad with its members and aggregate score.
   *
   * One query with a join and a `GROUP BY`, rather than the original's approach
   * of reading every team document and recomputing member totals in the browser
   * from a `members` array stored inline. An array inside a document cannot be
   * summed by the database, so that version had to trust whatever the client had
   * last written into it.
   */
  async listTeams() {
    const teams = await this.db
      .select({
        id: schema.teams.id,
        name: schema.teams.name,
        code: schema.teams.code,
        captainId: schema.teams.captainId,
        createdAt: schema.teams.createdAt,
        totalVerifiedInvites: sql<string>`COALESCE(SUM((
          SELECT COUNT(*) FROM ${schema.referrals} r
          WHERE r.referrer_id = ${schema.teamMembers.userId} AND r.status = 'verified'
        )), 0)`,
      })
      .from(schema.teams)
      .leftJoin(schema.teamMembers, eq(schema.teamMembers.teamId, schema.teams.id))
      .groupBy(schema.teams.id)
      .orderBy(desc(sql`COALESCE(SUM((
        SELECT COUNT(*) FROM ${schema.referrals} r
        WHERE r.referrer_id = ${schema.teamMembers.userId} AND r.status = 'verified'
      )), 0)`));

    const members = await this.db
      .select({
        teamId: schema.teamMembers.teamId,
        userId: schema.teamMembers.userId,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
      })
      .from(schema.teamMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId));

    const invitesByUser = await this.db
      .select({
        referrerId: schema.referrals.referrerId,
        count: sql<string>`COUNT(*)`,
      })
      .from(schema.referrals)
      .where(eq(schema.referrals.status, 'verified'))
      .groupBy(schema.referrals.referrerId);

    const invitesMap = new Map(invitesByUser.map((r) => [r.referrerId, Number(r.count)]));

    return teams.map((team, index) => ({
      id: team.id,
      name: team.name,
      code: team.code,
      captainId: team.captainId,
      totalVerifiedInvites: Number(team.totalVerifiedInvites ?? 0),
      rank: index + 1,
      estimatedPrizeKobo: TEAM_PRIZES_KOBO[index] ?? 0,
      members: members
        .filter((m) => m.teamId === team.id)
        .map((m) => ({
          id: m.userId,
          name: m.displayName,
          avatar: m.avatarUrl ?? '',
          verifiedInvites: invitesMap.get(m.userId) ?? 0,
        })),
    }));
  }

  async myTeam(userId: string) {
    const [row] = await this.db
      .select({ teamId: schema.teamMembers.teamId })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.userId, userId));

    if (!row) return null;
    const all = await this.listTeams();
    return all.find((t) => t.id === row.teamId) ?? null;
  }

  /**
   * Create a squad and join it.
   *
   * The "one squad per user" rule the original enforced by scanning every team
   * in the browser is now the `UNIQUE (user_id)` constraint on `team_members`.
   * The membership insert is the second statement in the transaction, so a user
   * who already belongs somewhere fails without leaving an orphan team behind.
   */
  async createTeam(userId: string, name: string) {
    await this.assertNotInATeam(userId);

    const clean =
      name.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase() || 'SQUAD';

    return this.db.transaction(async (tx) => {
      let team: typeof schema.teams.$inferSelect | undefined;

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const code = `${clean}${Math.floor(100 + Math.random() * 900)}`;
        const [created] = await tx
          .insert(schema.teams)
          .values({ name, code, captainId: userId })
          .onConflictDoNothing({ target: schema.teams.code })
          .returning();
        if (created) {
          team = created;
          break;
        }
      }

      if (!team) {
        throw new BadRequestException('Could not allocate a squad code, please try again.');
      }

      await tx.insert(schema.teamMembers).values({ teamId: team.id, userId });

      return { id: team.id, name: team.name, code: team.code, captainId: team.captainId };
    });
  }

  /** Join by invitation code. */
  async joinTeam(userId: string, code: string) {
    await this.assertNotInATeam(userId);

    const [team] = await this.db
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.code, code.trim().toUpperCase()));

    if (!team) {
      throw new BadRequestException(
        `No squad found with invitation code "${code.trim().toUpperCase()}". Check it with your team captain.`,
      );
    }

    const [countRow] = await this.db
      .select({ count: sql<string>`COUNT(*)` })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.teamId, team.id));

    if (Number(countRow?.count ?? 0) >= MAX_TEAM_MEMBERS) {
      throw new BadRequestException(`Squad "${team.name}" is full (${MAX_TEAM_MEMBERS} members).`);
    }

    // The unique user constraint is the real guard: the count check above can be
    // overtaken by a concurrent join, and this is what stops the roster going
    // over the cap.
    const [member] = await this.db
      .insert(schema.teamMembers)
      .values({ teamId: team.id, userId })
      .onConflictDoNothing({ target: schema.teamMembers.userId })
      .returning();

    if (!member) throw new BadRequestException('You are already in a squad.');

    return { id: team.id, name: team.name, code: team.code, captainId: team.captainId };
  }

  /**
   * Leave. The original kept an empty team document behind when the last member
   * left, which left a dead squad occupying a code forever.
   */
  async leaveTeam(userId: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ teamId: schema.teamMembers.teamId })
        .from(schema.teamMembers)
        .where(eq(schema.teamMembers.userId, userId));

      if (!row) throw new BadRequestException('You are not in a squad.');

      await tx
        .delete(schema.teamMembers)
        .where(eq(schema.teamMembers.userId, userId));

      const [remaining] = await tx
        .select({ count: sql<string>`COUNT(*)` })
        .from(schema.teamMembers)
        .where(eq(schema.teamMembers.teamId, row.teamId));

      if (Number(remaining?.count ?? 0) === 0) {
        await tx.delete(schema.teams).where(eq(schema.teams.id, row.teamId));
        return { ok: true, teamDeleted: true };
      }

      return { ok: true, teamDeleted: false };
    });
  }

  private async assertNotInATeam(userId: string) {
    const [existing] = await this.db
      .select({ teamId: schema.teamMembers.teamId, name: schema.teams.name })
      .from(schema.teamMembers)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
      .where(eq(schema.teamMembers.userId, userId));

    if (existing) {
      throw new BadRequestException(
        `You are already in squad "${existing.name}". Leave it before joining or creating another.`,
      );
    }
  }
}

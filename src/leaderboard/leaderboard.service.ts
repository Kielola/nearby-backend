import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';

export type LeaderboardPeriod = 'weekly' | 'biweekly' | 'monthly' | 'all_time';

/**
 * Prize pools, in kobo. Identical to the original app's figures.
 */
export const PRIZE_TABLE_KOBO: Record<LeaderboardPeriod, number[]> = {
  weekly: [2_000_000, 1_000_000, 500_000], //              ₦20,000 / ₦10,000 / ₦5,000
  biweekly: [3_000_000, 1_500_000, 750_000], //            ₦30,000 / ₦15,000 / ₦7,500
  monthly: [5_000_000, 3_000_000, 2_000_000], //           ₦50,000 / ₦30,000 / ₦20,000
  all_time: [10_000_000, 5_000_000, 2_500_000, 1_000_000, 500_000], // ₦100k / ₦50k / ₦25k / ₦10k / ₦5k
};

export const PERIOD_DAYS: Record<LeaderboardPeriod, number | null> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  all_time: null,
};

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger('leaderboard');

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  /**
   * The ranked board.
   *
   * ## Why this is a query and not a sort in the browser
   *
   * The original fetched `users.limit(100)`, sorted them in JavaScript, and
   * rendered the result as the global leaderboard. Two things were wrong with
   * that, and both were silent:
   *
   *   - **Anyone past position 100 did not exist.** Not ranked low — absent.
   *     Whether you appeared at all depended on which 100 documents Firestore
   *     happened to return.
   *   - **The ranking was wrong**, because the top 100 documents are not the top
   *     100 referrers. The genuinely best referrer could be anywhere in the
   *     database and simply never be in the sample.
   *
   * Here the database does the ordering, so the list is correct at any scale and
   * costs the same at 100 users or 100,000.
   */
  async getLeaderboard(period: LeaderboardPeriod, limit = 50, offset = 0) {
    const windowDays = PERIOD_DAYS[period];

    const conditions = [eq(schema.referrals.status, 'verified')];
    if (windowDays !== null) {
      const since = new Date(Date.now() - windowDays * 86_400_000);
      conditions.push(gte(schema.referrals.createdAt, since));
    }

    const rows = await this.db
      .select({
        userId: schema.users.id,
        name: schema.users.displayName,
        avatar: schema.users.avatarUrl,
        campus: schema.users.streetName,
        verifiedInvites: sql<string>`COUNT(*)`,
        firstReferralAt: sql<string>`MIN(${schema.referrals.createdAt})`,
      })
      .from(schema.referrals)
      .innerJoin(schema.users, eq(schema.users.id, schema.referrals.referrerId))
      .where(and(...conditions))
      .groupBy(schema.users.id, schema.users.displayName, schema.users.avatarUrl, schema.users.streetName)
      .orderBy(desc(sql`COUNT(*)`), sql`MIN(${schema.referrals.createdAt})`)
      .limit(Math.min(Math.max(limit, 1), 200))
      .offset(Math.max(offset, 0));

    const prizes = PRIZE_TABLE_KOBO[period];

    return rows.map((row, index) => ({
      rank: offset + index + 1,
      userId: row.userId,
      name: row.name,
      avatar: row.avatar ?? '',
      campus: row.campus ?? '',
      verifiedInvites: Number(row.verifiedInvites ?? 0),
      prizeKobo: offset + index < prizes.length ? prizes[offset + index] : 0,
    }));
  }

  /**
   * One user's standing, and how far they are from the next position.
   *
   * Computed with a `COUNT` of the people strictly ahead, rather than by
   * fetching the board and finding yourself in it — the original's approach,
   * which returned "not ranked" for anyone past the sample.
   */
  async getUserRank(userId: string, period: LeaderboardPeriod) {
    const board = await this.topScores(period);

    const mineRow = board.find((r) => r.userId === userId);
    const myCount = mineRow ? Number(mineRow.verifiedInvites) : 0;

    const ahead = board.filter(
      (r) => r.userId !== userId && Number(r.verifiedInvites) > myCount,
    ).length;

    const rank = myCount > 0 ? ahead + 1 : null;
    const prizes = PRIZE_TABLE_KOBO[period];

    // The person immediately above, so the UI can say exactly what is needed to
    // overtake — which is the number that actually motivates more invites.
    const nextUp = board
      .filter((r) => Number(r.verifiedInvites) > myCount)
      .sort((a, b) => Number(a.verifiedInvites) - Number(b.verifiedInvites))[0];

    return {
      rank,
      verifiedInvites: myCount,
      prizeKobo: rank !== null && rank <= prizes.length ? prizes[rank - 1] : 0,
      nextRankGap: nextUp ? Number(nextUp.verifiedInvites) - myCount + 1 : 0,
      nextRankPrizeKobo:
        rank !== null && rank - 1 <= prizes.length ? (prizes[rank - 2] ?? 0) : prizes[0] ?? 0,
    };
  }

  /** Everyone with at least one verified referral, in the window. Used for the
   *  exact rank computation — bounded by participation, not by an arbitrary
   *  document limit. */
  private async topScores(period: LeaderboardPeriod) {
    const windowDays = PERIOD_DAYS[period];
    const conditions = [eq(schema.referrals.status, 'verified')];
    if (windowDays !== null) {
      conditions.push(gte(schema.referrals.createdAt, new Date(Date.now() - windowDays * 86_400_000)));
    }

    const rows = await this.db
      .select({
        userId: schema.referrals.referrerId,
        verifiedInvites: sql<string>`COUNT(*)`,
      })
      .from(schema.referrals)
      .where(and(...conditions))
      .groupBy(schema.referrals.referrerId);

    return rows.map((r) => ({ userId: r.userId, verifiedInvites: Number(r.verifiedInvites ?? 0) }));
  }

  /** All four boards in one response. */
  async getAllBoards(limit = 50) {
    const [weekly, biweekly, monthly, allTime] = await Promise.all([
      this.getLeaderboard('weekly', limit),
      this.getLeaderboard('biweekly', limit),
      this.getLeaderboard('monthly', limit),
      this.getLeaderboard('all_time', limit),
    ]);

    return {
      weekly,
      biweekly,
      monthly,
      allTime,
      prizes: {
        weekly: PRIZE_TABLE_KOBO.weekly,
        biweekly: PRIZE_TABLE_KOBO.biweekly,
        monthly: PRIZE_TABLE_KOBO.monthly,
        allTime: PRIZE_TABLE_KOBO.all_time,
      },
    };
  }

  /**
   * Freeze a finished period.
   *
   * The original recomputed every board from live data on every render, so last
   * month's result stopped existing the moment the window rolled — a user who
   * was told they came second had nothing to point at. A snapshot makes the
   * result durable and payable.
   *
   * Idempotent by `UNIQUE (period, period_start)`: running it twice for the same
   * period writes once.
   */
  async snapshot(period: LeaderboardPeriod, periodStart: Date, periodEnd: Date) {
    const board = await this.getLeaderboard(period, 200);

    const [created] = await this.db
      .insert(schema.leaderboardSnapshots)
      .values({
        period,
        periodStart,
        periodEnd,
        payload: JSON.stringify(board),
      })
      .onConflictDoNothing({
        target: [schema.leaderboardSnapshots.period, schema.leaderboardSnapshots.periodStart],
      })
      .returning();

    if (!created) return { created: false };

    this.logger.log(
      `[leaderboard] snapshot ${period} ${periodStart.toISOString()} — ${board.length} entries`,
    );
    return { created: true, entries: board.length, id: created.id };
  }

  async listSnapshots(period?: LeaderboardPeriod) {
    // `.limit()` is applied to the builder, before it is awaited — awaiting
    // first would run the query and hand back a plain array, which has no
    // `.limit()`.
    const base = period
      ? this.db
          .select()
          .from(schema.leaderboardSnapshots)
          .where(eq(schema.leaderboardSnapshots.period, period))
      : this.db.select().from(schema.leaderboardSnapshots);

    return base.orderBy(desc(schema.leaderboardSnapshots.periodStart)).limit(100);
  }
}

import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { createHash } from 'crypto';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';
import { LedgerService } from '../ledger/ledger.service';
import { MilestonesService } from '../milestones/milestones.service';
import { NotificationsService } from '../notifications/notifications.service';
import { formatNaira } from '../common/money';

/** Where the invite link sends people. Used to build the shareable link. */
const APP_ORIGIN = process.env.REFERRAL_APP_ORIGIN ?? 'https://nearby.fashfos.com';

export function hashIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger('referrals');

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly ledger: LedgerService,
    private readonly milestones: MilestonesService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Codes ────────────────────────────────────────────────────────────────

  /**
   * The user's referral code, created on first request.
   *
   * Format matches the original app: first four letters of the display name,
   * uppercased, plus four digits. Uniqueness is enforced by the column, so a
   * collision is retried rather than trusted — `Math.random()` without a unique
   * index is how the original could hand two users the same code.
   */
  async ensureCode(userId: string): Promise<string> {
    const [existing] = await this.db
      .select()
      .from(schema.referralCodes)
      .where(eq(schema.referralCodes.userId, userId));

    if (existing) return existing.code;

    const [user] = await this.db
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    const base =
      (user?.displayName ?? 'USER')
        .replace(/[^a-zA-Z]/g, '')
        .substring(0, 4)
        .toUpperCase() || 'NEARBY';

    // Ten attempts against a unique column. The search space is 9,000 per prefix
    // and the prefix is per-name, so a genuine exhaustion is not a real risk —
    // but failing loudly after ten is better than looping forever.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = `${base}${Math.floor(1000 + Math.random() * 9000)}`;
      const [created] = await this.db
        .insert(schema.referralCodes)
        .values({ userId, code })
        .onConflictDoNothing()
        .returning();
      if (created) return created.code;
    }

    throw new BadRequestException('Could not allocate a referral code, please try again.');
  }

  async referralLink(userId: string): Promise<string> {
    const code = await this.ensureCode(userId);
    return `${APP_ORIGIN}/join/${code}`;
  }

  /** Resolve a code to the user who owns it. Checks personal codes first, then
   *  approved influencer codes — the two are separate namespaces. */
  async resolveCode(code: string): Promise<{ userId: string; kind: 'user' | 'influencer' } | null> {
    const clean = code.trim().toUpperCase();

    const [owner] = await this.db
      .select({ userId: schema.referralCodes.userId })
      .from(schema.referralCodes)
      .where(eq(schema.referralCodes.code, clean));
    if (owner) return { userId: owner.userId, kind: 'user' };

    const [influencer] = await this.db
      .select({ userId: schema.influencers.userId, status: schema.influencers.status })
      .from(schema.influencers)
      .where(eq(schema.influencers.customCode, clean));
    if (influencer && influencer.status === 'approved') {
      return { userId: influencer.userId, kind: 'influencer' };
    }

    return null;
  }

  // ── Funnel: clicks ───────────────────────────────────────────────────────

  async logClick(code: string, ip: string | undefined, userAgent: string | undefined) {
    const resolved = await this.resolveCode(code);
    await this.db.insert(schema.referralClicks).values({
      code: code.trim().toUpperCase(),
      referrerId: resolved?.userId ?? null,
      ipHash: hashIp(ip),
      userAgent: userAgent?.slice(0, 300) ?? null,
    });
    return { ok: true };
  }

  // ── Attribution ──────────────────────────────────────────────────────────

  /**
   * Record that `referredUserId` signed up using `code`.
   *
   * Called by the client straight after account creation, with the code it
   * captured from the invite link. The client supplies only the code and its own
   * identity — never a referrer id, never a count — so it cannot assert an
   * attribution that did not happen.
   *
   * Duplicate protection is the `UNIQUE (referred_user_id)` constraint, not a
   * read-then-check: two concurrent signups racing on the same referred user is
   * exactly the case a check-then-write gets wrong.
   */
  async attribute(input: { referredUserId: string; code: string; ip?: string; deviceHash?: string }) {
    const resolved = await this.resolveCode(input.code);

    if (!resolved) {
      // Not an error worth failing signup over — the account exists and works.
      return { attributed: false, reason: 'code-not-found' as const };
    }

    if (resolved.userId === input.referredUserId) {
      return { attributed: false, reason: 'self-referral' as const };
    }

    const [created] = await this.db
      .insert(schema.referrals)
      .values({
        referrerId: resolved.userId,
        referredUserId: input.referredUserId,
        codeUsed: input.code.trim().toUpperCase(),
        status: 'pending',
        step: 'Registered',
        ipHash: hashIp(input.ip),
        deviceHash: input.deviceHash?.slice(0, 128) ?? null,
      })
      .onConflictDoNothing({ target: schema.referrals.referredUserId })
      .returning();

    if (!created) {
      return { attributed: false, reason: 'already-referred' as const };
    }

    this.logger.log(`[referrals] ${input.referredUserId} attributed to ${resolved.userId}`);

    await this.notifications.create(resolved.userId, {
      userId: resolved.userId,
      type: 'referral',
      title: 'Someone joined with your link',
      message: 'A new member signed up with your invite link. It counts once they verify.',
    });

    // The funnel's "installed" and "registered" steps are the same event in a
    // web app; both are recorded so the analytics the UI already shows keep
    // their existing shape.
    return { attributed: true, referrerId: resolved.userId, kind: resolved.kind };
  }

  /**
   * Promote a referral to `verified` once the referred user qualifies.
   *
   * Qualification is deliberately not "they created an account". The original
   * app counted a referral the moment the account existed, which pays for a
   * throwaway email address. Requiring the referred user to actually become a
   * user — terms accepted and a profile with a name — costs nothing honest and
   * removes the cheapest form of farming.
   */
  async qualify(referredUserId: string) {
    const [referral] = await this.db
      .select()
      .from(schema.referrals)
      .where(
        and(
          eq(schema.referrals.referredUserId, referredUserId),
          eq(schema.referrals.status, 'pending'),
        ),
      );

    if (!referral) return { qualified: false, reason: 'no-pending-referral' as const };

    // The rule stated above, actually enforced: an account that has not accepted
    // the terms and has not set a name is not yet "a user". Failing this is not
    // an error — the client calls this again after onboarding, and it succeeds
    // then. That is what makes the cheap farm (many throwaway signups, zero real
    // accounts) worth nothing.
    const [referred] = await this.db
      .select({
        displayName: schema.users.displayName,
        termsAcceptedAt: schema.users.termsAcceptedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, referredUserId));

    if (!referred?.termsAcceptedAt) {
      return { qualified: false, reason: 'terms-not-accepted' as const };
    }
    if (!referred.displayName || referred.displayName === 'New User') {
      return { qualified: false, reason: 'no-display-name' as const };
    }

    const [updated] = await this.db
      .update(schema.referrals)
      .set({ status: 'verified', step: 'Verified Account', qualifiedAt: new Date() })
      .where(eq(schema.referrals.id, referral.id))
      .returning();

    const verifiedCount = await this.countVerified(referral.referrerId);

    // Influencer commission — the real rate applied to a real referral, rather
    // than the original's `verifiedInvites * 100` synthesis.
    const [influencer] = await this.db
      .select()
      .from(schema.influencers)
      .where(eq(schema.influencers.userId, referral.referrerId));

    if (influencer && influencer.status === 'approved') {
      await this.ledger.apply({
        userId: influencer.userId,
        deltaKobo: influencer.commissionKobo,
        reason: 'influencer_commission',
        sourceType: 'referral',
        sourceId: referral.id,
        description: `Influencer commission — ${formatNaira(influencer.commissionKobo)}`,
        idempotencyKey: `influencer_commission:${referral.id}`,
      });
    }

    await this.notifications.create(referral.referrerId, {
      userId: referral.referrerId,
      type: 'referral',
      title: 'New verified referral',
      message: `You now have ${verifiedCount} verified referral${verifiedCount === 1 ? '' : 's'}.`,
    });

    // Tiers that pay automatically (20 and 50 in the original app) are settled
    // here, once, through the milestone system — so they cannot also be claimed
    // by hand and paid twice.
    const auto = await this.milestones.autoClaimFor(referral.referrerId, verifiedCount);

    return { qualified: true, referrerId: referral.referrerId, verifiedCount, autoClaimed: auto };
  }

  async countVerified(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<string>`COUNT(*)` })
      .from(schema.referrals)
      .where(and(eq(schema.referrals.referrerId, userId), eq(schema.referrals.status, 'verified')));
    return Number(row?.count ?? 0);
  }

  // ── Retention ────────────────────────────────────────────────────────────

  /**
   * Recompute retention for every referral, from server data only.
   *
   * The original derived `daysElapsed` from the referred user's **last active**
   * time and compared it against itself, so the resulting percentage was
   * arithmetic on a moving number — meaningless, and it was shown to users as
   * their referral's engagement.
   *
   * The measurement here is a definition that can actually be computed from what
   * the database stores, and it never takes the client's word for anything:
   *
   *   active days = the span between the referral being created and the referred
   *                 user's most recent activity, capped at the 7-day window.
   *
   * So "100%" means they were still using Nearby a week after signing up, and a
   * referral that went quiet on day two reads as 29%. Both numbers are true, and
   * both are reproducible later from the stored timestamps.
   *
   * One statement, so it scales past a few hundred rows. Intended to be run on a
   * schedule; exposed as an admin endpoint until a scheduler is wired up.
   */
  async recomputeRetention() {
    const result = await this.db.execute(sql`
      UPDATE ${schema.referrals} AS r
      SET retention_active_days = derived.active_days,
          retention_rate_percent = derived.rate_percent
      FROM (
        SELECT
          r2.id,
          LEAST(
            GREATEST(
              FLOOR(EXTRACT(EPOCH FROM (
                LEAST(COALESCE(u.last_active_at, r2.created_at), NOW()) - r2.created_at
              )) / 86400),
              0
            ),
            7
          )::int AS active_days,
          LEAST(
            ROUND(
              (
                LEAST(
                  GREATEST(
                    FLOOR(EXTRACT(EPOCH FROM (
                      LEAST(COALESCE(u.last_active_at, r2.created_at), NOW()) - r2.created_at
                    )) / 86400),
                    0
                  ),
                  GREATEST(1, LEAST(FLOOR(EXTRACT(EPOCH FROM (NOW() - r2.created_at)) / 86400), 7))
                )
              ) * 100.0
            ) / GREATEST(1, LEAST(FLOOR(EXTRACT(EPOCH FROM (NOW() - r2.created_at)) / 86400), 7))
          )::int AS rate_percent
        FROM ${schema.referrals} AS r2
        INNER JOIN ${schema.users} AS u ON u.id = r2.referred_user_id
      ) AS derived
      WHERE r.id = derived.id
    `);

    return { updated: true, rowsAffected: (result as { count?: number })?.count ?? null };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** Everything the referral hub needs in one response. */
  async myProfile(userId: string) {
    const code = await this.ensureCode(userId);

    const [counts] = await this.db
      .select({
        verified: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'verified')`,
        pending: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'pending')`,
        fraudulent: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'fraudulent')`,
      })
      .from(schema.referrals)
      .where(eq(schema.referrals.referrerId, userId));

    const [user] = await this.db
      .select({
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        bio: schema.users.bio,
        customStatus: schema.users.customStatus,
        // Needed for the Area vs Area challenge panel, which has to tell the user
        // which area their referrals are being counted towards.
        streetName: schema.users.streetName,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId));

    const verified = Number(counts?.verified ?? 0);
    const [balanceKobo, lifetimeKobo, claims, teamRow] = await Promise.all([
      this.ledger.balanceKobo(userId),
      this.ledger.lifetimeEarnedKobo(userId),
      this.db
        .select({ milestoneKey: schema.milestoneClaims.milestoneKey })
        .from(schema.milestoneClaims)
        .where(eq(schema.milestoneClaims.userId, userId)),
      this.db
        .select({ teamId: schema.teamMembers.teamId, teamName: schema.teams.name })
        .from(schema.teamMembers)
        .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
        .where(eq(schema.teamMembers.userId, userId)),
    ]);

    const [influencer] = await this.db
      .select({
        status: schema.influencers.status,
        customCode: schema.influencers.customCode,
        commissionKobo: schema.influencers.commissionKobo,
      })
      .from(schema.influencers)
      .where(eq(schema.influencers.userId, userId));

    return {
      userId,
      name: user?.displayName ?? 'Nearby Member',
      avatar: user?.avatarUrl ?? '',
      bio: user?.bio ?? '',
      // The area this user is competing for in the monthly Area vs Area challenge.
      // Without it the challenge screen cannot tell someone which area their
      // referrals are being counted towards, which is the first thing they need.
      areaName: user?.streetName ?? null,
      referralCode: code,
      referralLink: `${APP_ORIGIN}/join/${code}`,
      verifiedInvites: verified,
      pendingInvites: Number(counts?.pending ?? 0),
      fraudulentInvites: Number(counts?.fraudulent ?? 0),
      isAmbassador: verified >= 100,
      badges: this.badgesFor(verified, influencer?.status === 'approved'),
      claimedMilestones: claims.map((c) => c.milestoneKey),
      balanceKobo,
      lifetimeEarnedKobo: lifetimeKobo,
      teamId: teamRow[0]?.teamId ?? null,
      teamName: teamRow[0]?.teamName ?? null,
      influencer: influencer ?? null,
    };
  }

  /** Badge rules from the original app, with the thresholds it used. */
  private badgesFor(verified: number, isInfluencer: boolean) {
    const badges: { id: string; name: string; description: string }[] = [];
    if (verified >= 100) {
      badges.push({
        id: 'ambassador',
        name: 'Ambassador VIP',
        description: 'Reached 100 verified referrals',
      });
    }
    if (verified >= 30) {
      badges.push({
        id: 'community_builder',
        name: 'Community Builder',
        description: 'Reached 30 verified referrals',
      });
    }
    if (verified >= 20) {
      badges.push({
        id: 'top_referrer',
        name: 'Top Referrer',
        description: 'Reached 20 verified referrals',
      });
    }
    if (isInfluencer) {
      badges.push({
        id: 'campus_creator',
        name: 'Campus Creator',
        description: 'Approved campus influencer',
      });
    }
    return badges;
  }

  /** The referral list, newest first, with the funnel step each one reached. */
  async myReferrals(userId: string) {
    const rows = await this.db
      .select({
        id: schema.referrals.id,
        referredUserId: schema.referrals.referredUserId,
        referredUserName: schema.users.displayName,
        status: schema.referrals.status,
        step: schema.referrals.step,
        codeUsed: schema.referrals.codeUsed,
        retentionActiveDays: schema.referrals.retentionActiveDays,
        retentionRatePercent: schema.referrals.retentionRatePercent,
        createdAt: schema.referrals.createdAt,
        qualifiedAt: schema.referrals.qualifiedAt,
      })
      .from(schema.referrals)
      .innerJoin(schema.users, eq(schema.users.id, schema.referrals.referredUserId))
      .where(eq(schema.referrals.referrerId, userId))
      .orderBy(desc(schema.referrals.createdAt))
      .limit(200);

    return rows;
  }

  /**
   * The funnel analytics the hub displays.
   *
   * `clicks` is a real count from `referral_clicks`. The original logged clicks
   * and then overwrote the figure with `Math.max(clicks, verified + installs)` —
   * a fabricated number presented to users as their performance.
   */
  async myAnalytics(userId: string) {
    const [clickRow] = await this.db
      .select({ count: sql<string>`COUNT(*)` })
      .from(schema.referralClicks)
      .where(eq(schema.referralClicks.referrerId, userId));

    const [counts] = await this.db
      .select({
        total: sql<string>`COUNT(*)`,
        verified: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'verified')`,
        pending: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'pending')`,
        fraudulent: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'fraudulent')`,
      })
      .from(schema.referrals)
      .where(eq(schema.referrals.referrerId, userId));

    const clicks = Number(clickRow?.count ?? 0);
    const total = Number(counts?.total ?? 0);
    const verified = Number(counts?.verified ?? 0);

    return {
      clicks,
      installs: total,
      successfulRegistrations: total,
      verifiedReferrals: verified,
      fraudulentReferrals: Number(counts?.fraudulent ?? 0),
      conversionRate: clicks > 0 ? Math.round((verified / clicks) * 100) : 0,
    };
  }

  // ── Abuse review ─────────────────────────────────────────────────────────

  /**
   * Risk score for a payout review, 0–100.
   *
   * The original always returned 10 unless an already-flagged record existed —
   * and nothing in the codebase ever set `FRAUDULENT`, so it was 10 forever.
   * These signals are all real and all computable from stored data.
   */
  async riskScore(userId: string): Promise<number> {
    const [row] = await this.db
      .select({
        verified: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'verified')`,
        fraudulent: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'fraudulent')`,
        sharedIps: sql<string>`COUNT(DISTINCT ${schema.referrals.ipHash}) FILTER (WHERE ${schema.referrals.ipHash} IS NOT NULL)`,
        total: sql<string>`COUNT(*)`,
        firstAt: sql<string>`MIN(${schema.referrals.createdAt})`,
        lastAt: sql<string>`MAX(${schema.referrals.createdAt})`,
      })
      .from(schema.referrals)
      .where(eq(schema.referrals.referrerId, userId));

    let score = 0;
    const total = Number(row?.total ?? 0);
    const verified = Number(row?.verified ?? 0);
    const fraudulent = Number(row?.fraudulent ?? 0);
    const sharedIps = Number(row?.sharedIps ?? 0);

    // Already-flagged referrals.
    if (fraudulent > 0) score += Math.min(40, fraudulent * 20);

    // Every referral from one IP is the signature of one person with many
    // accounts.
    if (total >= 3 && sharedIps <= 1) score += 30;

    // A burst: many referrals inside a single day.
    if (row?.firstAt && row?.lastAt && total > 5) {
      const spanHours =
        (new Date(row.lastAt).getTime() - new Date(row.firstAt).getTime()) / 3_600_000;
      if (spanHours < 24) score += 20;
    }

    // Nothing verified but plenty recorded — accounts that were made and
    // abandoned, which is what farming looks like.
    if (total >= 5 && verified === 0) score += 20;

    return Math.max(0, Math.min(100, score));
  }

  /** Admin: refuse a referral. Never counts toward a milestone or a payout. */
  async markFraudulent(referralId: string, reason: string) {
    const [updated] = await this.db
      .update(schema.referrals)
      .set({ status: 'fraudulent', step: `Flagged: ${reason}`.slice(0, 200) })
      .where(eq(schema.referrals.id, referralId))
      .returning();
    return updated ?? null;
  }

  /** Admin: everything awaiting review. */
  async listForReview(limit = 100) {
    return this.db
      .select({
        id: schema.referrals.id,
        referrerId: schema.referrals.referrerId,
        referredUserId: schema.referrals.referredUserId,
        status: schema.referrals.status,
        ipHash: schema.referrals.ipHash,
        deviceHash: schema.referrals.deviceHash,
        createdAt: schema.referrals.createdAt,
      })
      .from(schema.referrals)
      .orderBy(desc(schema.referrals.createdAt))
      .limit(Math.min(limit, 500));
  }
}

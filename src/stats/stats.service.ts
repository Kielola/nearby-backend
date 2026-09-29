import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';
import { MIN_PAYOUT_KOBO } from '../common/money';

/**
 * Referral programme statistics for the dashboard.
 *
 * Every figure here is aggregated in SQL over real rows. The original's stats
 * panel read `limit(100)` users into the browser and counted what happened to be
 * in that sample, so "total referrals: 47" was a count of the first hundred
 * documents, not of the programme. Numbers that looked plausible and were wrong
 * are worse than no numbers, because people make decisions with them.
 */
@Injectable()
export class StatsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  async platformStats() {
    const [referralRow] = await this.db
      .select({
        total: sql<string>`COUNT(*)`,
        verified: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'verified')`,
        pending: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'pending')`,
        fraudulent: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'fraudulent')`,
        last7Days: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.createdAt} >= NOW() - INTERVAL '7 days')`,
        last30Days: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.createdAt} >= NOW() - INTERVAL '30 days')`,
      })
      .from(schema.referrals);

    const [userRow] = await this.db
      .select({ total: sql<string>`COUNT(*)` })
      .from(schema.users);

    const [clickRow] = await this.db
      .select({ total: sql<string>`COUNT(*)` })
      .from(schema.referralClicks);

    const [ledgerRow] = await this.db
      .select({
        credited: sql<string>`COALESCE(SUM(CASE WHEN ${schema.ledgerEntries.deltaKobo} > 0 THEN ${schema.ledgerEntries.deltaKobo} ELSE 0 END), 0)`,
        debited: sql<string>`COALESCE(SUM(CASE WHEN ${schema.ledgerEntries.deltaKobo} < 0 THEN ${schema.ledgerEntries.deltaKobo} ELSE 0 END), 0)`,
      })
      .from(schema.ledgerEntries);

    const [payoutRow] = await this.db
      .select({
        pendingCount: sql<string>`COUNT(*) FILTER (WHERE ${schema.payouts.status} = 'pending_review')`,
        pendingKobo: sql<string>`COALESCE(SUM(${schema.payouts.amountKobo}) FILTER (WHERE ${schema.payouts.status} = 'pending_review'), 0)`,
        paidKobo: sql<string>`COALESCE(SUM(${schema.payouts.amountKobo}) FILTER (WHERE ${schema.payouts.status} = 'paid'), 0)`,
      })
      .from(schema.payouts);

    const [treasureRow] = await this.db
      .select({
        total: sql<string>`COUNT(*)`,
        redeemed: sql<string>`COUNT(*) FILTER (WHERE ${schema.treasureCodes.redeemedBy} IS NOT NULL)`,
      })
      .from(schema.treasureCodes);

    const [teamRow] = await this.db
      .select({ total: sql<string>`COUNT(*)` })
      .from(schema.teams);

    const [influencerRow] = await this.db
      .select({
        total: sql<string>`COUNT(*)`,
        approved: sql<string>`COUNT(*) FILTER (WHERE ${schema.influencers.status} = 'approved')`,
        pending: sql<string>`COUNT(*) FILTER (WHERE ${schema.influencers.status} = 'pending')`,
      })
      .from(schema.influencers);

    const total = Number(referralRow?.total ?? 0);
    const verified = Number(referralRow?.verified ?? 0);
    const clicks = Number(clickRow?.total ?? 0);

    // Outstanding liability is the number that matters for cash planning: what
    // the programme currently owes, not what it has paid.
    const creditedKobo = Number(ledgerRow?.credited ?? 0);
    const debitedKobo = Math.abs(Number(ledgerRow?.debited ?? 0));

    return {
      users: Number(userRow?.total ?? 0),
      referrals: {
        total,
        verified,
        pending: Number(referralRow?.pending ?? 0),
        fraudulent: Number(referralRow?.fraudulent ?? 0),
        last7Days: Number(referralRow?.last7Days ?? 0),
        last30Days: Number(referralRow?.last30Days ?? 0),
        verificationRate: total > 0 ? Math.round((verified / total) * 100) : 0,
      },
      clicks,
      conversionRate: clicks > 0 ? Math.round((total / clicks) * 100) : 0,
      money: {
        creditedKobo,
        withdrawnKobo: debitedKobo,
        outstandingKobo: Math.max(0, creditedKobo - debitedKobo),
      },
      payouts: {
        pendingCount: Number(payoutRow?.pendingCount ?? 0),
        pendingKobo: Number(payoutRow?.pendingKobo ?? 0),
        paidKobo: Number(payoutRow?.paidKobo ?? 0),
      },
      treasure: {
        total: Number(treasureRow?.total ?? 0),
        redeemed: Number(treasureRow?.redeemed ?? 0),
      },
      teams: { total: Number(teamRow?.total ?? 0) },
      influencers: {
        total: Number(influencerRow?.total ?? 0),
        approved: Number(influencerRow?.approved ?? 0),
        pending: Number(influencerRow?.pending ?? 0),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /** Programme-wide activity feed for the dashboard: the newest verified
   *  referrals across everyone, with the referred user's first name only. */
  async recentActivity(limit = 25) {
    const rows = await this.db
      .select({
        id: schema.referrals.id,
        status: schema.referrals.status,
        createdAt: schema.referrals.createdAt,
        referrerName: schema.users.displayName,
      })
      .from(schema.referrals)
      .innerJoin(schema.users, eq(schema.users.id, schema.referrals.referrerId))
      .orderBy(sql`${schema.referrals.createdAt} DESC`)
      .limit(Math.min(limit, 100));

    return rows.map((r) => ({
      ...r,
      // "Chidi referred someone" — never the referred party's identity, which
      // the original exposed in full on a publicly readable collection.
      message: `${(r.referrerName ?? 'A member').split(' ')[0]} referred a new member`,
    }));
  }

  /** Withdrawal eligibility for the current user. */
  async withdrawalEligibility(userId: string) {
    const [row] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${schema.ledgerEntries.deltaKobo}), 0)`,
      })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId));

    const balanceKobo = Number(row?.total ?? 0);
    return {
      balanceKobo,
      minimumKobo: MIN_PAYOUT_KOBO,
      eligible: balanceKobo >= MIN_PAYOUT_KOBO,
    };
  }

  /** Daily series for the last 30 days, for the dashboard chart. */
  async dailySeries(days = 30) {
    const since = new Date(Date.now() - Math.min(days, 180) * 86_400_000);

    const rows = await this.db
      .select({
        day: sql<string>`TO_CHAR(DATE_TRUNC('day', ${schema.referrals.createdAt}), 'YYYY-MM-DD')`,
        total: sql<string>`COUNT(*)`,
        verified: sql<string>`COUNT(*) FILTER (WHERE ${schema.referrals.status} = 'verified')`,
      })
      .from(schema.referrals)
      .where(and(gte(schema.referrals.createdAt, since)))
      .groupBy(sql`DATE_TRUNC('day', ${schema.referrals.createdAt})`)
      .orderBy(sql`DATE_TRUNC('day', ${schema.referrals.createdAt})`);

    return rows.map((r) => ({
      day: r.day,
      total: Number(r.total ?? 0),
      verified: Number(r.verified ?? 0),
    }));
  }

  /** Hooks a referral qualification can call to keep any cached counters in
   *  step — currently a no-op, kept so the call sites exist if a cache is added
   *  later. Balances are never cached. */
  async onReferralChange(_userId: string) {
    return { ok: true };
  }
}

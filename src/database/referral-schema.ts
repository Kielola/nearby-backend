import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  timestamp,
  boolean,
  pgEnum,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './schema';

/**
 * Referral, rewards and payouts schema.
 *
 * ## The two rules this file encodes
 *
 * 1. **Money is `integer`, in kobo.** Never a float, never naira. A float naira
 *    balance accumulates rounding error the moment you start crediting
 *    ₦2,000 + ₦2,000 + ₦5,000, and the error is unreproducible and unarguable.
 *    Integers are exact. The ceiling on a single `integer` entry is
 *    ₦21,474,836 — far above any single credit this system makes.
 *
 * 2. **Balances are never stored.** There is no `balance` column anywhere,
 *    deliberately. A balance is `SUM(delta_kobo)` over `ledger_entries`, which
 *    is append-only. That means no client can forge a balance by writing a
 *    field, and every naira can answer "where did this come from?".
 *
 * The previous implementation stored `claimableBalanceNaira` as a mutable field
 * on the user document and did the arithmetic in the browser, with the whole
 * database open to `allow read, write: if true`. Everything here replaces that.
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export const referralStatusEnum = pgEnum('referral_status', [
  'pending', // recorded, referred user has not yet qualified
  'verified', // referred user qualified — counts toward milestones
  'fraudulent', // refused by review; never counts
]);

export const milestoneRewardTypeEnum = pgEnum('milestone_reward_type', [
  'subscription',
  'cash',
  'badge',
  'swag',
  'ambassador',
]);

export const payoutStatusEnum = pgEnum('payout_status', [
  'pending_review',
  'approved',
  'paid',
  'rejected',
]);

export const payoutTypeEnum = pgEnum('payout_type', [
  'referral_earnings',
  'treasure_hunt',
  'leaderboard_prize',
  'team_prize',
  'milestone_reward',
]);

export const influencerStatusEnum = pgEnum('influencer_status', [
  'pending',
  'approved',
  'rejected',
]);

export const leaderboardPeriodEnum = pgEnum('leaderboard_period', [
  'weekly',
  'biweekly',
  'monthly',
  'all_time',
]);

/** Why a ledger entry exists. Constrained so a typo cannot create an
 *  unaccountable category of money. */
export const ledgerReasonEnum = pgEnum('ledger_reason', [
  'milestone_reward',
  'treasure_prize',
  'leaderboard_prize',
  'team_prize',
  'influencer_commission',
  'admin_adjustment',
  'payout_hold',
  'payout_refund',
]);

// ─── Referral codes & attribution ───────────────────────────────────────────

export const referralCodes = pgTable('referral_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  // One code per user, forever. `unique` here is what makes that a database
  // guarantee instead of a convention the next developer has to remember.
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  code: text('code').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const referrals = pgTable(
  'referrals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    referrerId: uuid('referrer_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * UNIQUE. A person can be referred once, ever — enforced by the database,
     * not by a read-then-check-then-write sequence that two concurrent signups
     * can both pass. This single constraint replaces the old duplicate check.
     */
    referredUserId: uuid('referred_user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeUsed: text('code_used').notNull(),
    status: referralStatusEnum('status').notNull().default('pending'),
    /** Where the referred user is in the funnel: clicked → installed →
     *  registered → verified. Kept as free text so a new step does not need a
     *  migration. */
    step: text('step').notNull().default('Registered'),
    /** Captured at signup for abuse review. Hashed, never the raw address —
     *  same treatment as `users.terms_accepted_ip_hash`. */
    ipHash: text('ip_hash'),
    deviceHash: text('device_hash'),
    /** Days the referred user has been active, and the derived 7-day rate.
     *  Computed server-side; the old implementation derived `daysElapsed` from
     *  the user's *last active* time, which made the percentage meaningless. */
    retentionActiveDays: integer('retention_active_days').notNull().default(0),
    retentionRatePercent: integer('retention_rate_percent').notNull().default(0),
    /** Set when the referred user satisfies the qualification rule. */
    qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    referrerIdx: index('referrals_referrer_idx').on(table.referrerId),
    statusIdx: index('referrals_status_idx').on(table.status),
  }),
);

/**
 * One row per visit to an invite link. Powers the "clicks" figure in the
 * funnel analytics — the old app logged these but then computed
 * `clicks = Math.max(clicks, verified + installs)`, i.e. invented the number.
 */
export const referralClicks = pgTable(
  'referral_clicks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    referrerId: uuid('referrer_id').references(() => users.id, { onDelete: 'set null' }),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeIdx: index('referral_clicks_code_idx').on(table.code),
  }),
);

// ─── The ledger ─────────────────────────────────────────────────────────────

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Signed. Credits are positive, holds and refunds negative/positive. */
    deltaKobo: integer('delta_kobo').notNull(),
    reason: ledgerReasonEnum('reason').notNull(),
    /** What caused it — a milestone key, a treasure code id, a payout id. */
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    /** Free-text shown to the user in their earnings history. */
    description: text('description'),
    /**
     * UNIQUE. Every earning action carries a caller-supplied key; a retry — a
     * flaky mobile network, a double tap, an offline queue flushing twice —
     * inserts nothing the second time. This is the same idempotency pattern
     * that fixed the duplicate-message bug in chat, applied to money.
     */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('ledger_entries_user_idx').on(table.userId),
  }),
);

// ─── Milestones ─────────────────────────────────────────────────────────────

export const milestones = pgTable('milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  invitesRequired: integer('invites_required').notNull(),
  rewardTitle: text('reward_title').notNull(),
  rewardDescription: text('reward_description').notNull(),
  rewardType: milestoneRewardTypeEnum('reward_type').notNull(),
  /** 0 for non-cash rewards (badge, subscription, ambassador). */
  valueKobo: integer('value_kobo').notNull().default(0),
  badgeName: text('badge_name'),
  /** NULL = unlimited. Otherwise a global cap across all users. */
  limitTotal: integer('limit_total'),
  claimedTotal: integer('claimed_total').notNull().default(0),
  /**
   * Auto-claimed the moment the threshold is crossed, rather than waiting for a
   * tap. The original app paid the 20- and 50-invite bonuses automatically
   * inside `recordReferral` while ALSO listing them as claimable milestones —
   * so those two tiers could pay twice. Making it explicit here pays once, and
   * keeps the behaviour users already saw for those tiers.
   */
  autoClaim: boolean('auto_claim').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const milestoneClaims = pgTable(
  'milestone_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    milestoneKey: text('milestone_key').notNull(),
    invitesAtClaim: integer('invites_at_claim').notNull(),
    valueKobo: integer('value_kobo').notNull().default(0),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One claim per user per milestone — again a constraint, not a check.
    uniqueUserMilestone: unique().on(table.userId, table.milestoneKey),
  }),
);

// ─── Teams / squads ─────────────────────────────────────────────────────────

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  captainId: uuid('captain_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** UNIQUE: one squad per person, enforced by the database. */
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamIdx: index('team_members_team_idx').on(table.teamId),
  }),
);

// ─── Treasure hunt ──────────────────────────────────────────────────────────

export const treasureCodes = pgTable(
  'treasure_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    campusName: text('campus_name').notNull(),
    locationHint: text('location_hint').notNull(),
    prizeKobo: integer('prize_kobo').notNull(),
    /** 1, 2 or 3 — the campaign month. Caps are per user per month. */
    monthNumber: integer('month_number').notNull().default(1),
    /** Optional campus coordinates. When present, a claim made with a GPS fix
     *  that is not within `radiusMeters` is refused. When the claimer has no
     *  usable location the check is skipped, so a user with location problems
     *  is never locked out of a mechanic they physically attended. */
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    radiusMeters: integer('radius_meters').notNull().default(3000),
    redeemedBy: uuid('redeemed_by').references(() => users.id, { onDelete: 'set null' }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    monthIdx: index('treasure_codes_month_idx').on(table.monthNumber),
  }),
);

// ─── Payouts ────────────────────────────────────────────────────────────────

export const payouts = pgTable(
  'payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    amountKobo: integer('amount_kobo').notNull(),
    type: payoutTypeEnum('type').notNull().default('referral_earnings'),
    bankName: text('bank_name').notNull(),
    accountNumber: text('account_number').notNull(),
    accountName: text('account_name').notNull(),
    status: payoutStatusEnum('status').notNull().default('pending_review'),
    /** 0–100. Computed server-side from this user's referral history. */
    fraudRiskScore: integer('fraud_risk_score').notNull().default(0),
    referralsVerifiedAtRequest: integer('referrals_verified_at_request').notNull().default(0),
    /** Social-tag confirmation step, carried over from the original flow. */
    socialTagHandle: text('social_tag_handle'),
    socialTagConfirmed: boolean('social_tag_confirmed').notNull().default(false),
    rejectionReason: text('rejection_reason'),
    /** Firebase uid of whoever reviewed it. Admin action is recorded, not
     *  anonymous. */
    reviewedBy: text('reviewed_by'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('payouts_user_idx').on(table.userId),
    statusIdx: index('payouts_status_idx').on(table.status),
  }),
);

// ─── Influencers ────────────────────────────────────────────────────────────

export const influencers = pgTable('influencers', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  instagram: text('instagram'),
  tiktok: text('tiktok'),
  twitter: text('twitter'),
  youtube: text('youtube'),
  customCode: text('custom_code').notNull().unique(),
  campaignName: text('campaign_name').notNull(),
  status: influencerStatusEnum('status').notNull().default('pending'),
  /** Per-referral commission, in kobo. The original hardcoded ₦100 and then
   *  multiplied it by the invite count to synthesise an analytics figure. Here
   *  it is a real rate applied to real referrals. */
  commissionKobo: integer('commission_kobo').notNull().default(10000),
  rejectionReason: text('rejection_reason'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── Leaderboard snapshots ──────────────────────────────────────────────────

/**
 * Ranks are computed on read (see LeaderboardService) — this table exists so a
 * finished period's result is frozen and can be paid out or disputed later.
 * Without it, "you were 2nd last month" is unknowable once the month rolls.
 */
export const leaderboardSnapshots = pgTable(
  'leaderboard_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    period: leaderboardPeriodEnum('period').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    /** The full ranked list, frozen. */
    payload: text('payload').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniquePeriod: unique().on(table.period, table.periodStart),
  }),
);

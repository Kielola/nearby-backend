import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, notInArray, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { formatNaira } from '../common/money';

/**
 * Milestone tiers.
 *
 * These are the exact five tiers from the original app, with the same thresholds
 * and the same values. `autoClaim` marks the two the original paid automatically
 * inside `recordReferral` — the 20 and 50 invite bonuses.
 *
 * WHY `autoClaim` EXISTS AT ALL
 *
 * The original had a double-payment bug: `recordReferral` credited ₦2,000 at 20
 * invites and ₦5,000 at 50 invites *directly*, while `claimMilestoneReward`
 * offered the same two tiers as manually claimable. A user who crossed 20 could
 * therefore be paid ₦2,000 automatically and then claim ₦2,000 again.
 *
 * Rather than silently change what users see, these two tiers keep paying
 * automatically — but through the claim table, which has a
 * `UNIQUE (user_id, milestone_key)` constraint. The manual claim for a tier
 * already auto-claimed is refused as "already claimed", so it pays once and the
 * behaviour is unchanged.
 */
/**
 * How the reward actually works.
 *
 *     ₦2,000 for every completed block of 10 verified referrals.
 *
 * Cumulative and repeating, not a one-off:
 *
 *     10 referrals -> ₦2,000
 *     20 referrals -> ₦4,000      (2 blocks)
 *     30 referrals -> ₦6,000      (3 blocks)
 *     50 referrals -> ₦10,000     (5 blocks)
 *
 * That last line is the number the Area vs Area challenge is built on: the
 * monthly challenge requires at least 50 verified referrals, which under this
 * table is also exactly ₦10,000 earned from the referral rate alone.
 *
 * ## What this replaced, and why it mattered
 *
 * The previous table paid ₦2,000 at 20 invites and ₦5,000 at 50, with nothing at
 * 10 and nothing repeating. It had been carried over from an earlier version of
 * the app and did not match the reward the business actually advertises.
 *
 * The mismatch was not cosmetic. A user reaching 10 verified referrals — which
 * the app told them was worth ₦2,000 — would see a balance of ₦0 and no tier
 * crossed. The app would have been advertising a reward the database did not pay,
 * which is the kind of thing that turns into a public accusation rather than a bug
 * report.
 *
 * ## Why the tiers are generated rather than written out
 *
 * Because the rule IS "every 10". Ten hand-written entries invite a typo into one
 * of them, and a typo here is a wrong payment. The loop cannot drift out of step
 * with the description above because there is only one place the number lives.
 */
const REWARD_PER_BLOCK_KOBO = 200_000; // ₦2,000
const REFERRALS_PER_BLOCK = 10;
const MAX_TIER_INVITES = 100;

export const MILESTONE_TIERS = Array.from(
  { length: MAX_TIER_INVITES / REFERRALS_PER_BLOCK },
  (_, index) => {
    const invitesRequired = (index + 1) * REFERRALS_PER_BLOCK;
    const valueKobo = REWARD_PER_BLOCK_KOBO;

    return {
      key: `invites_${invitesRequired}`,
      invitesRequired,
      // Names the block, not the running total.
      //
      // `valueKobo` below is what this ONE tier credits — ₦2,000 — and the ledger
      // pays exactly that. Labelling it a "total" would misdescribe the payment,
      // and labelling it nothing distinguishes it from the other nine identical
      // rows, which is how the app ended up showing ₦2,000 ten times over as if
      // that were the whole reward.
      rewardTitle: `Block ${invitesRequired / REFERRALS_PER_BLOCK} of ₦${(
        valueKobo / 100
      ).toLocaleString('en-NG')}`,
      rewardDescription:
        `Block ${invitesRequired / REFERRALS_PER_BLOCK} of ${MAX_TIER_INVITES / REFERRALS_PER_BLOCK}. ` +
        `Each completed block of ${REFERRALS_PER_BLOCK} verified referrals pays ₦${(
          valueKobo / 100
        ).toLocaleString('en-NG')}, so reaching ${invitesRequired} means ` +
        `${invitesRequired / REFERRALS_PER_BLOCK} block${
          invitesRequired / REFERRALS_PER_BLOCK === 1 ? ' has' : 's have'
        } paid — ₦${(((invitesRequired / REFERRALS_PER_BLOCK) * valueKobo) / 100).toLocaleString(
          'en-NG',
        )} in total.`,
      rewardType: 'cash' as const,
      valueKobo,
      badgeName: null as string | null,
      limitTotal: null as number | null,
      // Paid the moment the threshold is crossed. With a repeating reward there is
      // nothing for the user to decide, and waiting for a tap would leave money
      // sitting unclaimed that they have already earned.
      autoClaim: true,
      sortOrder: invitesRequired,
    };
  },
);
@Injectable()
export class MilestonesService implements OnModuleInit {
  private readonly logger = new Logger('milestones');

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Sync the reward table on boot, without letting a failure kill the process. If
   * migrations have not been run against this database yet, the app should still
   * serve everything else and log loudly — not enter a crash loop.
   */
  async onModuleInit() {
    try {
      await this.syncTiers();
    } catch (error) {
      this.logger.warn(
        `[milestones] reward sync skipped — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Bring the `milestones` table in line with `MILESTONE_TIERS`.
   *
   * ## This used to be `seedIfEmpty`, and that was a silent failure waiting to
   * ## happen
   *
   * The old version inserted the tiers only when the table had zero rows. That
   * works exactly once, on a brand-new database, and then never again. On the live
   * database — which already held the previous five tiers — editing
   * `MILESTONE_TIERS` changed NOTHING. The code would have said ₦2,000 per ten
   * while the database went on paying the old amounts, and the only symptom would
   * have been users reporting that their balance did not match the app.
   *
   * So the table is now synced on every boot: upsert by `key`, exactly like
   * reference data. The code is the source of truth, and a deploy is all it takes
   * to change a reward.
   *
   * ## What is deliberately NOT overwritten
   *
   * `claimedTotal` is live data, not configuration — it is how many times a tier
   * has actually been claimed across all users. The upsert leaves it alone; a
   * restart must never reset a counter that money depends on.
   *
   * Tiers that no longer exist in code are deactivated rather than deleted.
   * Deletion would break the foreign key from `milestone_claims`, destroying the
   * record of rewards already paid out — the one record that must survive.
   */
  async syncTiers() {
    const keys = MILESTONE_TIERS.map((tier) => tier.key);

    await this.db
      .insert(schema.milestones)
      .values(MILESTONE_TIERS)
      .onConflictDoUpdate({
        target: schema.milestones.key,
        set: {
          invitesRequired: sql`excluded.invites_required`,
          rewardTitle: sql`excluded.reward_title`,
          rewardDescription: sql`excluded.reward_description`,
          rewardType: sql`excluded.reward_type`,
          valueKobo: sql`excluded.value_kobo`,
          badgeName: sql`excluded.badge_name`,
          limitTotal: sql`excluded.limit_total`,
          autoClaim: sql`excluded.auto_claim`,
          sortOrder: sql`excluded.sort_order`,
          active: true,
          // claimedTotal deliberately absent — see above.
        },
      });

    const retired = await this.db
      .update(schema.milestones)
      .set({ active: false })
      .where(notInArray(schema.milestones.key, keys))
      .returning({ key: schema.milestones.key });

    this.logger.log(
      `[milestones] synced ${MILESTONE_TIERS.length} reward tiers` +
        (retired.length > 0 ? `, retired ${retired.map((r) => r.key).join(', ')}` : ''),
    );

    return { synced: MILESTONE_TIERS.length, retired: retired.map((r) => r.key) };
  }

  /** All tiers, each with this user's claim state resolved. */
  async listForUser(userId: string) {
    const tiers = await this.db
      .select()
      .from(schema.milestones)
      .where(eq(schema.milestones.active, true))
      .orderBy(asc(schema.milestones.sortOrder));

    const claims = await this.db
      .select({ milestoneKey: schema.milestoneClaims.milestoneKey })
      .from(schema.milestoneClaims)
      .where(eq(schema.milestoneClaims.userId, userId));

    const claimed = new Set(claims.map((c) => c.milestoneKey));
    const verified = await this.verifiedCount(userId);

    return tiers.map((tier) => ({
      key: tier.key,
      invitesRequired: tier.invitesRequired,
      rewardTitle: tier.rewardTitle,
      rewardDescription: tier.rewardDescription,
      rewardType: tier.rewardType,
      valueKobo: tier.valueKobo,
      badgeName: tier.badgeName,
      limitTotal: tier.limitTotal,
      claimedGlobalCount: tier.claimedTotal,
      claimed: claimed.has(tier.key),
      // A limited tier can be full while a user is still eligible — the UI needs
      // to know the difference between "not yet" and "too late".
      soldOut: tier.limitTotal !== null && tier.claimedTotal >= tier.limitTotal,
      eligible: verified >= tier.invitesRequired,
    }));
  }

  private async verifiedCount(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<string>`COUNT(*)` })
      .from(schema.referrals)
      .where(and(eq(schema.referrals.referrerId, userId), eq(schema.referrals.status, 'verified')));
    return Number(row?.count ?? 0);
  }

  /**
   * Claim a tier.
   *
   * Every guard the original had is preserved — threshold, already-claimed,
   * global limited count — but the ordering is fixed. The original checked the
   * limit, incremented `claimedGlobalCount`, then did several more awaits before
   * crediting; two simultaneous claims could both pass the check. Here the claim
   * row is inserted FIRST, inside a transaction, and the unique constraint
   * decides who wins.
   */
  async claim(userId: string, milestoneKey: string) {
    const [tier] = await this.db
      .select()
      .from(schema.milestones)
      .where(eq(schema.milestones.key, milestoneKey));

    if (!tier || !tier.active) throw new BadRequestException('Unknown milestone.');

    const verified = await this.verifiedCount(userId);
    if (verified < tier.invitesRequired) {
      throw new BadRequestException(
        `You have ${verified} verified invite${verified === 1 ? '' : 's'}. ${tier.invitesRequired} required.`,
      );
    }

    if (tier.limitTotal !== null && tier.claimedTotal >= tier.limitTotal) {
      throw new BadRequestException(
        'Sorry, this limited-edition reward has reached maximum capacity.',
      );
    }

    return this.db.transaction(async (tx) => {
      // The race is settled here: whichever request inserts first wins, and the
      // loser gets zero rows rather than a second payout.
      const [claimRow] = await tx
        .insert(schema.milestoneClaims)
        .values({
          userId,
          milestoneKey,
          invitesAtClaim: verified,
          valueKobo: tier.valueKobo,
        })
        .onConflictDoNothing({
          target: [schema.milestoneClaims.userId, schema.milestoneClaims.milestoneKey],
        })
        .returning();

      if (!claimRow) {
        throw new BadRequestException('This reward has already been claimed.');
      }

      if (tier.limitTotal !== null) {
        await tx
          .update(schema.milestones)
          .set({ claimedTotal: sql`${schema.milestones.claimedTotal} + 1` })
          .where(eq(schema.milestones.key, milestoneKey));
      }

      if (tier.valueKobo > 0) {
        await this.ledger.apply({
          userId,
          deltaKobo: tier.valueKobo,
          reason: 'milestone_reward',
          sourceType: 'milestone',
          sourceId: milestoneKey,
          description: `${tier.rewardTitle} — ${formatNaira(tier.valueKobo)}`,
          idempotencyKey: `milestone:${userId}:${milestoneKey}`,
        }, tx);
      }

      await this.notifications.create(userId, {
        userId,
        type: 'referral',
        title: 'Milestone reward claimed',
        message:
          tier.valueKobo > 0
            ? `${tier.rewardTitle} unlocked. ${formatNaira(tier.valueKobo)} added to your balance.`
            : `${tier.rewardTitle} unlocked.`,
      });

      return {
        success: true,
        milestoneKey,
        valueKobo: tier.valueKobo,
        message:
          tier.valueKobo > 0
            ? `Milestone unlocked! ${formatNaira(tier.valueKobo)} added to your balance.`
            : `Milestone unlocked! ${tier.rewardTitle}.`,
      };
    });
  }

  /**
   * Settle every `autoClaim` tier the user has now reached.
   *
   * Called on each qualification. Returns the total credited so the caller can
   * report it.
   */
  async autoClaimFor(userId: string, verifiedCount: number) {
    const tiers = await this.db
      .select()
      .from(schema.milestones)
      .where(and(eq(schema.milestones.autoClaim, true), eq(schema.milestones.active, true)))
      .orderBy(asc(schema.milestones.sortOrder));

    let creditedKobo = 0;
    const claimed: string[] = [];

    for (const tier of tiers) {
      if (verifiedCount < tier.invitesRequired) continue;

      const [claimRow] = await this.db
        .insert(schema.milestoneClaims)
        .values({
          userId,
          milestoneKey: tier.key,
          invitesAtClaim: verifiedCount,
          valueKobo: tier.valueKobo,
        })
        .onConflictDoNothing({
          target: [schema.milestoneClaims.userId, schema.milestoneClaims.milestoneKey],
        })
        .returning();

      // Already claimed on a previous qualification — nothing to do, and
      // crucially nothing to pay again.
      if (!claimRow) continue;

      if (tier.limitTotal !== null) {
        await this.db
          .update(schema.milestones)
          .set({ claimedTotal: sql`${schema.milestones.claimedTotal} + 1` })
          .where(eq(schema.milestones.key, tier.key));
      }

      if (tier.valueKobo > 0) {
        await this.ledger.apply({
          userId,
          deltaKobo: tier.valueKobo,
          reason: 'milestone_reward',
          sourceType: 'milestone',
          sourceId: tier.key,
          description: `${tier.rewardTitle} — ${formatNaira(tier.valueKobo)}`,
          idempotencyKey: `milestone:${userId}:${tier.key}`,
        });
        creditedKobo += tier.valueKobo;
      }

      await this.notifications.create(userId, {
        userId,
        type: 'referral',
        title: 'Milestone reward unlocked',
        message:
          tier.valueKobo > 0
            ? `${tier.rewardTitle} — ${formatNaira(tier.valueKobo)} added to your balance.`
            : `${tier.rewardTitle} unlocked.`,
      });

      claimed.push(tier.key);
    }

    return { claimed, creditedKobo };
  }
}

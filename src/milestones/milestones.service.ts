import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
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
export const MILESTONE_TIERS = [
  {
    key: 'invites_5',
    invitesRequired: 5,
    rewardTitle: '1-Month Premium subscription',
    rewardDescription:
      'Enjoy 1 month of Nearby Premium features (unlimited radar filter, priority badges) after your first 3 free trial months.',
    rewardType: 'subscription' as const,
    valueKobo: 0,
    badgeName: null as string | null,
    limitTotal: null as number | null,
    autoClaim: false,
    sortOrder: 1,
  },
  {
    key: 'invites_20',
    invitesRequired: 20,
    rewardTitle: '₦2,000 cash reward',
    rewardDescription:
      '₦2,000 credited directly to your balance for inviting 20 verified friends.',
    rewardType: 'cash' as const,
    valueKobo: 200_000, // ₦2,000 in kobo
    badgeName: null,
    limitTotal: null,
    autoClaim: true,
    sortOrder: 2,
  },
  {
    key: 'invites_30',
    invitesRequired: 30,
    rewardTitle: 'Exclusive "Community Builder" badge',
    rewardDescription:
      'Ultra-rare badge strictly limited to early community builders. Displays proudly on your Nearby profile.',
    rewardType: 'badge' as const,
    valueKobo: 0,
    badgeName: 'Community Builder',
    limitTotal: 1000,
    autoClaim: false,
    sortOrder: 3,
  },
  {
    key: 'invites_50',
    invitesRequired: 50,
    rewardTitle: 'Nearby T-Shirt & ₦5,000 cash',
    rewardDescription:
      'Receive a branded Nearby official T-Shirt + ₦5,000 cash bonus.',
    rewardType: 'swag' as const,
    valueKobo: 500_000, // ₦5,000 in kobo
    badgeName: null,
    limitTotal: 100,
    autoClaim: true,
    sortOrder: 4,
  },
  {
    key: 'invites_100',
    invitesRequired: 100,
    rewardTitle: 'Nearby Ambassador status',
    rewardDescription:
      'Become an official Nearby Ambassador — executive status, direct line to leadership, monthly stipends and exclusive invitations.',
    rewardType: 'ambassador' as const,
    valueKobo: 0,
    badgeName: 'Ambassador VIP',
    limitTotal: null,
    autoClaim: false,
    sortOrder: 5,
  },
];

@Injectable()
export class MilestonesService implements OnModuleInit {
  private readonly logger = new Logger('milestones');

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Seed on boot, without letting a failure kill the process. If migrations
   * have not been run against this database yet, the app should still serve
   * everything else and log loudly — not enter a crash loop.
   */
  async onModuleInit() {
    try {
      await this.seedIfEmpty();
    } catch (error) {
      this.logger.warn(
        `[milestones] seeding skipped — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Insert the tier rows if the table is empty.
   *
   * Seeding from code on startup rather than from the browser on mount, which is
   * what the original did — `seedMilestonesIfEmpty` ran in the client, so any
   * visitor could trigger a write and the seeded values were whatever build they
   * happened to be running.
   */
  async seedIfEmpty() {
    const [row] = await this.db
      .select({ count: sql<string>`COUNT(*)` })
      .from(schema.milestones);

    if (Number(row?.count ?? 0) > 0) return { seeded: false };

    await this.db.insert(schema.milestones).values(MILESTONE_TIERS).onConflictDoNothing();
    this.logger.log(`[milestones] seeded ${MILESTONE_TIERS.length} tiers`);
    return { seeded: true, count: MILESTONE_TIERS.length };
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

import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';
import { NotificationsService } from '../notifications/notifications.service';
import { formatNaira } from '../common/money';

/** Ranking prize pool from the original paid-influencer leaderboard, in kobo. */
const INFLUENCER_PRIZES_KOBO = [8_000_000, 4_000_000, 2_000_000, 1_000_000, 1_000_000];

/** Default commission per verified referral: ₦100. */
const DEFAULT_COMMISSION_KOBO = 10_000;

@Injectable()
export class InfluencersService {
  private readonly logger = new Logger('influencers');

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Apply to the programme.
   *
   * Analytics are NOT stored — they are computed in `listApproved` from the
   * real referral rows. The original wrote `clicks: 12` and
   * `conversionRate: 85` as literals into the application document and then
   * showed those to creators as their performance.
   */
  async apply(
    userId: string,
    input: {
      instagram?: string;
      tiktok?: string;
      twitter?: string;
      youtube?: string;
      customCode: string;
      campaignName: string;
    },
  ) {
    const [existing] = await this.db
      .select()
      .from(schema.influencers)
      .where(eq(schema.influencers.userId, userId));

    if (existing) {
      throw new BadRequestException(
        existing.status === 'pending'
          ? 'Your application is already awaiting review.'
          : `Your application was ${existing.status}.`,
      );
    }

    const code = input.customCode.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,32}$/.test(code)) {
      throw new BadRequestException(
        'Custom code must be 3–32 characters, letters, numbers and hyphens only.',
      );
    }

    // A custom code must not collide with an existing personal referral code —
    // two codes resolving to different people would make attribution ambiguous.
    const [clash] = await this.db
      .select({ userId: schema.referralCodes.userId })
      .from(schema.referralCodes)
      .where(eq(schema.referralCodes.code, code));
    if (clash) throw new BadRequestException(`The code "${code}" is already taken.`);

    const [created] = await this.db
      .insert(schema.influencers)
      .values({
        userId,
        instagram: input.instagram ?? null,
        tiktok: input.tiktok ?? null,
        twitter: input.twitter ?? null,
        youtube: input.youtube ?? null,
        customCode: code,
        campaignName: input.campaignName,
        commissionKobo: DEFAULT_COMMISSION_KOBO,
      })
      .onConflictDoNothing({ target: schema.influencers.userId })
      .returning();

    if (!created) throw new BadRequestException('You already have an application.');

    await this.notifications.create(userId, {
      userId,
      type: 'referral',
      title: 'Influencer application received',
      message: 'Your Campus Creator application is pending verification.',
    });

    return {
      success: true,
      message: 'Application submitted. Pending review.',
      influencerId: created.id,
    };
  }

  /** Approved creators, ranked, with real analytics. */
  async listApproved() {
    const rows = await this.db
      .select({
        id: schema.influencers.id,
        userId: schema.influencers.userId,
        name: schema.users.displayName,
        avatar: schema.users.avatarUrl,
        campus: schema.users.streetName,
        customCode: schema.influencers.customCode,
        campaignName: schema.influencers.campaignName,
        handles: sql<Record<string, string | null>>`json_build_object(
          'instagram', ${schema.influencers.instagram},
          'tiktok', ${schema.influencers.tiktok},
          'twitter', ${schema.influencers.twitter},
          'youtube', ${schema.influencers.youtube}
        )`,
        commissionKobo: schema.influencers.commissionKobo,
        verifiedReferrals: sql<string>`(
          SELECT COUNT(*) FROM ${schema.referrals} r
          WHERE r.referrer_id = ${schema.influencers.userId} AND r.status = 'verified'
        )`,
      })
      .from(schema.influencers)
      .innerJoin(schema.users, eq(schema.users.id, schema.influencers.userId))
      .where(eq(schema.influencers.status, 'approved'));

    const ranked = rows
      .map((r) => ({
        ...r,
        verifiedReferrals: Number(r.verifiedReferrals ?? 0),
      }))
      .sort((a, b) => b.verifiedReferrals - a.verifiedReferrals)
      .map((r, index) => ({
        ...r,
        rank: index + 1,
        prizeKobo: INFLUENCER_PRIZES_KOBO[index] ?? 0,
        estimatedCommissionKobo: r.verifiedReferrals * r.commissionKobo,
      }));

    // Real click counts, attached per creator. One grouped query rather than a
    // query per creator.
    const clicks = await this.db
      .select({
        referrerId: schema.referralClicks.referrerId,
        count: sql<string>`COUNT(*)`,
      })
      .from(schema.referralClicks)
      .groupBy(schema.referralClicks.referrerId);

    const clickMap = new Map(clicks.map((c) => [c.referrerId, Number(c.count ?? 0)]));

    return ranked.map((r) => {
      const clickCount = clickMap.get(r.userId) ?? 0;
      return {
        ...r,
        analytics: {
          clicks: clickCount,
          installs: r.verifiedReferrals,
          verifiedReferrals: r.verifiedReferrals,
          conversionRate: clickCount > 0 ? Math.round((r.verifiedReferrals / clickCount) * 100) : 0,
        },
      };
    });
  }

  /** Admin: all applications regardless of status. */
  async listAll() {
    return this.db
      .select({
        id: schema.influencers.id,
        userId: schema.influencers.userId,
        name: schema.users.displayName,
        email: schema.users.email,
        customCode: schema.influencers.customCode,
        campaignName: schema.influencers.campaignName,
        status: schema.influencers.status,
        commissionKobo: schema.influencers.commissionKobo,
        createdAt: schema.influencers.createdAt,
      })
      .from(schema.influencers)
      .innerJoin(schema.users, eq(schema.users.id, schema.influencers.userId))
      .orderBy(desc(schema.influencers.createdAt))
      .limit(200);
  }

  async setStatus(
    influencerId: string,
    status: 'approved' | 'rejected',
    reason?: string,
  ) {
    const [updated] = await this.db
      .update(schema.influencers)
      .set({
        status,
        rejectionReason: status === 'rejected' ? (reason ?? null) : null,
        verifiedAt: status === 'approved' ? new Date() : null,
      })
      .where(eq(schema.influencers.id, influencerId))
      .returning();

    if (!updated) throw new BadRequestException('Application not found.');

    await this.notifications.create(updated.userId, {
      userId: updated.userId,
      type: 'referral',
      title: `Influencer application ${status}`,
      message:
        status === 'approved'
          ? `Your Campus Creator code ${updated.customCode} is live. You earn ${formatNaira(updated.commissionKobo)} per verified referral.`
          : `Your application was not approved: ${reason ?? 'no reason given'}.`,
    });

    return { success: true, status, customCode: updated.customCode };
  }

  async myApplication(userId: string) {
    const [row] = await this.db
      .select()
      .from(schema.influencers)
      .where(eq(schema.influencers.userId, userId));
    return row ?? null;
  }
}

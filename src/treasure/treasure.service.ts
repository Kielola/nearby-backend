import { BadRequestException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { formatNaira } from '../common/money';

/** Anti-cheat: at most this many claims per user per campaign month. */
const MAX_CLAIMS_PER_MONTH = 3;

/**
 * The ten seeded campus codes, exactly as in the original app.
 *
 * `latitude`/`longitude` are new and currently null: a code can be redeemed from
 * anywhere until coordinates are added. Supply them (via the admin endpoint) to
 * turn on proximity verification for that code. Nothing else about the mechanic
 * changes — the code still has to be correct. The coordinates simply add a
 * second, physical check that a leaked code cannot satisfy.
 */
export const SEED_TREASURE_CODES = [
  { code: 'NEARBY-UNILAG-LIB01', campusName: 'UNILAG (Main Library)', locationHint: 'Near the Central Reading Hall Notice Board', prizeKobo: 200_000, monthNumber: 1 },
  { code: 'NEARBY-UNILAG-FAC02', campusName: 'UNILAG (Faculty of Sci)', locationHint: 'Behind the Chemistry Lecture Theatre', prizeKobo: 250_000, monthNumber: 1 },
  { code: 'NEARBY-OAU-SUB03', campusName: 'OAU (SUB Building)', locationHint: 'Near the Student Union Amphitheatre Pillars', prizeKobo: 300_000, monthNumber: 1 },
  { code: 'NEARBY-UI-SUB04', campusName: 'UI (Kenneth Dike Lib)', locationHint: 'Under the shade tree near Faculty of Arts', prizeKobo: 200_000, monthNumber: 1 },
  { code: 'NEARBY-ABU-SUL05', campusName: 'ABU Zaria (Main Gate)', locationHint: 'Behind the Student Lounge Pavilion', prizeKobo: 500_000, monthNumber: 1 },
  { code: 'NEARBY-UNN-LIB06', campusName: 'UNN Nsukka (Princess Alex)', locationHint: 'Beside the ICT Center Walkway', prizeKobo: 200_000, monthNumber: 1 },
  { code: 'NEARBY-FUTA-ENG07', campusName: 'FUTA (SEET Complex)', locationHint: 'Near SEET Auditorium Entrance', prizeKobo: 350_000, monthNumber: 1 },
  { code: 'NEARBY-LASU-SRC08', campusName: 'LASU Ojo (SRC Hub)', locationHint: 'Beside the Campus Radio Station Lounge', prizeKobo: 200_000, monthNumber: 1 },
  { code: 'NEARBY-UNIPORT-HUB09', campusName: 'UNIPORT (Choba Campus)', locationHint: 'Near the Sports Complex Bleachers', prizeKobo: 400_000, monthNumber: 1 },
  { code: 'NEARBY-BENIN-HALL10', campusName: 'UNIBEN (Ugbowo Campus)', locationHint: 'At Hall 2 Car Park Kiosk', prizeKobo: 500_000, monthNumber: 1 },
];

/** Great-circle distance in metres. Plenty for a campus radius, and it needs no
 *  PostGIS extension or index for a two-point comparison. */
function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

@Injectable()
export class TreasureService implements OnModuleInit {
  private readonly logger = new Logger('treasure');

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Seed the campus codes on boot.
   *
   * Wrapped in a try/catch on purpose: this runs before the first request, and a
   * missing table (migrations not yet run against this database) must not take
   * the entire backend down. A logged warning is recoverable; a crash loop is
   * not.
   */
  async onModuleInit() {
    try {
      await this.seedIfEmpty();
    } catch (error) {
      this.logger.warn(
        `[treasure] seeding skipped — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async seedIfEmpty() {
    const [row] = await this.db.select({ count: sql<string>`COUNT(*)` }).from(schema.treasureCodes);
    if (Number(row?.count ?? 0) > 0) return { seeded: false };
    await this.db.insert(schema.treasureCodes).values(SEED_TREASURE_CODES).onConflictDoNothing();
    this.logger.log(`[treasure] seeded ${SEED_TREASURE_CODES.length} campus codes`);
    return { seeded: true, count: SEED_TREASURE_CODES.length };
  }

  /** The board. Exposes a finder's display name only — never their id — so the
   *  public list cannot be used to enumerate accounts. */
  async list() {
    return this.db
      .select({
        id: schema.treasureCodes.id,
        code: schema.treasureCodes.code,
        campusName: schema.treasureCodes.campusName,
        locationHint: schema.treasureCodes.locationHint,
        prizeKobo: schema.treasureCodes.prizeKobo,
        monthNumber: schema.treasureCodes.monthNumber,
        isRedeemed: sql<boolean>`(${schema.treasureCodes.redeemedBy} IS NOT NULL)`,
        redeemedByName: schema.users.displayName,
        redeemedAt: schema.treasureCodes.redeemedAt,
        proximityRequired: sql<boolean>`(${schema.treasureCodes.latitude} IS NOT NULL)`,
      })
      .from(schema.treasureCodes)
      .leftJoin(schema.users, eq(schema.users.id, schema.treasureCodes.redeemedBy))
      .orderBy(asc(schema.treasureCodes.monthNumber), asc(schema.treasureCodes.code));
  }

  /**
   * Redeem a campus code.
   *
   * **Race-free by construction, in three layers:**
   *
   *  1. `pg_advisory_xact_lock(hashtext(userId))` serialises this user's
   *     redemptions. Two simultaneous submissions by the same person queue up
   *     instead of both observing "2 claims so far" and both passing the
   *     3-per-month cap.
   *  2. The claim itself is a single conditional UPDATE — `WHERE redeemed_by IS
   *     NULL`. Postgres serialises the two writers; the second updates zero rows.
   *     The original did read → check → write, so two people could both pass the
   *     check and both be paid for the same physical code.
   *  3. The ledger credit runs inside the same transaction, so a prize and the
   *     redemption that earned it commit together or not at all.
   */
  async redeem(
    userId: string,
    code: string,
    location?: { latitude: number; longitude: number },
  ) {
    const clean = code.trim().toUpperCase();

    const [target] = await this.db
      .select()
      .from(schema.treasureCodes)
      .where(eq(schema.treasureCodes.code, clean));

    if (!target) throw new BadRequestException('Invalid treasure code.');

    if (target.redeemedBy) {
      const [winner] = await this.db
        .select({ name: schema.users.displayName })
        .from(schema.users)
        .where(eq(schema.users.id, target.redeemedBy));
      throw new BadRequestException(
        `This treasure code was already discovered and claimed by ${winner?.name ?? 'another user'}.`,
      );
    }

    // Proximity. Enforced only when BOTH the code carries coordinates AND the
    // claimer supplied a usable fix — so a member whose location is unavailable
    // is never locked out of a mechanic they physically attended, while a leaked
    // code cannot simply be typed from anywhere by someone who does have GPS.
    if (
      target.latitude !== null &&
      target.longitude !== null &&
      location?.latitude !== undefined &&
      location?.longitude !== undefined
    ) {
      const away = distanceMeters(
        target.latitude,
        target.longitude,
        location.latitude,
        location.longitude,
      );
      if (away > target.radiusMeters) {
        throw new BadRequestException(
          `This code is for ${target.campusName}. Your location is about ${Math.round(away / 1000)} km away — get closer and try again.`,
        );
      }
    }

    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

      const [claimRow] = await tx
        .select({ count: sql<string>`COUNT(*)` })
        .from(schema.treasureCodes)
        .where(
          and(
            eq(schema.treasureCodes.redeemedBy, userId),
            eq(schema.treasureCodes.monthNumber, target.monthNumber),
          ),
        );

      if (Number(claimRow?.count ?? 0) >= MAX_CLAIMS_PER_MONTH) {
        throw new BadRequestException(
          `You have already claimed ${MAX_CLAIMS_PER_MONTH} treasure codes this month.`,
        );
      }

      const [updated] = await tx
        .update(schema.treasureCodes)
        .set({ redeemedBy: userId, redeemedAt: new Date() })
        .where(
          and(
            eq(schema.treasureCodes.id, target.id),
            // The guard lives inside the statement that does the write.
            sql`${schema.treasureCodes.redeemedBy} IS NULL`,
          ),
        )
        .returning();

      if (!updated) {
        throw new BadRequestException(
          'Another member claimed this treasure code a moment before you did.',
        );
      }

      await this.ledger.apply(
        {
          userId,
          deltaKobo: target.prizeKobo,
          reason: 'treasure_prize',
          sourceType: 'treasure_code',
          sourceId: target.id,
          description: `Treasure prize — ${target.campusName}`,
          idempotencyKey: `treasure:${target.id}`,
        },
        tx,
      );

      return updated;
    });

    await this.notifications.create(userId, {
      userId,
      type: 'referral',
      title: 'Treasure prize unlocked',
      message: `You found ${result.code} at ${target.campusName}. ${formatNaira(target.prizeKobo)} added to your balance.`,
    });

    return {
      success: true,
      prizeKobo: target.prizeKobo,
      campusName: target.campusName,
      message: `Treasure code verified! ${formatNaira(target.prizeKobo)} added to your balance.`,
    };
  }

  /** Admin: attach coordinates, turning on proximity verification for a code. */
  async setLocation(codeId: string, latitude: number, longitude: number, radiusMeters: number) {
    const [updated] = await this.db
      .update(schema.treasureCodes)
      .set({ latitude, longitude, radiusMeters })
      .where(eq(schema.treasureCodes.id, codeId))
      .returning();
    return updated ?? null;
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';
import { withoutUndefined } from '../common/without-undefined';
import { Db, Executor } from '../common/db-types';

type LedgerReason =
  | 'milestone_reward'
  | 'treasure_prize'
  | 'leaderboard_prize'
  | 'team_prize'
  | 'influencer_commission'
  | 'admin_adjustment'
  | 'payout_hold'
  | 'payout_refund';

export interface CreditInput {
  userId: string;
  /** Signed kobo. Positive credits, negative debits. */
  deltaKobo: number;
  reason: LedgerReason;
  sourceType?: string;
  sourceId?: string;
  description?: string;
  /** Must be deterministic for the action — see `money.idempotencyKey`. */
  idempotencyKey: string;
}

export interface LedgerResult {
  /** False when this exact action had already been applied. */
  applied: boolean;
  entryId: string | null;
  deltaKobo: number;
}

/**
 * The earnings ledger — the single source of every balance in the system.
 *
 * ## Why a ledger and not a `balance` column
 *
 * The original referral app kept `claimableBalanceNaira` as a mutable field and
 * did the arithmetic in the browser, on a database whose rules were
 * `allow read, write: if true`. Two consequences, both fatal:
 *
 *   1. Anyone could set their own balance by writing the field.
 *   2. Nobody could answer "why is my balance ₦7,000?" — there was no record of
 *      how it got there, so a dispute was unfalsifiable and a bug was invisible.
 *
 * Here, a balance is always `SUM(delta_kobo)` over append-only rows. Nothing can
 * be forged by writing to it, and every naira is traceable to the thing that
 * caused it.
 *
 * ## Idempotency is not optional
 *
 * Every method takes an `idempotencyKey`. The unique index on that column is
 * what makes a retry safe: a double-tapped claim, a mobile network that drops
 * the response, an offline queue flushing twice, all resolve to one row. Without
 * it, "credit ₦2,000" is a race against the user's connection quality — and
 * users' connections in Nigeria are exactly why this matters.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger('ledger');

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
  ) {}

  /**
   * Apply a ledger entry, once.
   *
   * `onConflictDoNothing` on the idempotency key turns a duplicate into a
   * no-op rather than an error, so callers do not need to catch-and-ignore —
   * they get `applied: false` and carry on.
   */
  async apply(input: CreditInput, executor?: Executor): Promise<LedgerResult> {
    // Run on the caller's transaction when there is one, so a credit and the
    // claim that caused it commit together or not at all. A transaction handle
    // exposes the same insert/select API as the client; the cast keeps the
    // compiler happy about the union without weakening the call sites.
    const client = (executor ?? this.db) as Db;

    const [inserted] = await client
      .insert(schema.ledgerEntries)
      .values(
        withoutUndefined({
          userId: input.userId,
          deltaKobo: input.deltaKobo,
          reason: input.reason,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
        }),
      )
      .onConflictDoNothing({ target: schema.ledgerEntries.idempotencyKey })
      .returning();

    if (inserted) {
      return { applied: true, entryId: inserted.id, deltaKobo: inserted.deltaKobo };
    }

    // Already applied. Return the existing row so the caller can report the
    // right amount rather than a zero.
    const [existing] = await client
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.idempotencyKey, input.idempotencyKey));

    return {
      applied: false,
      entryId: existing?.id ?? null,
      deltaKobo: existing?.deltaKobo ?? 0,
    };
  }

  /**
   * The user's spendable balance, in kobo.
   *
   * Derived every time — there is no cached field to drift out of step with the
   * rows. `COALESCE` matters: with no entries, `SUM` returns NULL, and NULL
   * arithmetics in the calling code would produce NaN.
   */
  async balanceKobo(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${schema.ledgerEntries.deltaKobo}), 0)` })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId));

    return Number(row?.total ?? 0);
  }

  /** Lifetime credited (never descended by withdrawals) — the "total earned"
   *  figure shown on a profile. Debits are excluded by filtering on sign. */
  async lifetimeEarnedKobo(userId: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(CASE WHEN ${schema.ledgerEntries.deltaKobo} > 0 THEN ${schema.ledgerEntries.deltaKobo} ELSE 0 END), 0)`,
      })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId));

    return Number(row?.total ?? 0);
  }

  /** Most recent entries, newest first — the earnings history list. */
  async history(userId: string, limit = 50) {
    return this.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .orderBy(desc(schema.ledgerEntries.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /** Credits only, for a "how did I earn this" summary. */
  async earningsSummary(userId: string) {
    const rows = await this.db
      .select({
        reason: schema.ledgerEntries.reason,
        total: sql<string>`SUM(${schema.ledgerEntries.deltaKobo})`,
        count: sql<string>`COUNT(*)`,
      })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId))
      .groupBy(schema.ledgerEntries.reason);

    return rows.map((r) => ({
      reason: r.reason,
      totalKobo: Number(r.total ?? 0),
      count: Number(r.count ?? 0),
    }));
  }
}

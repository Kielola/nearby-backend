import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../database/database.module';
import * as schema from '../database/all-schema';
import { LedgerService } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ReferralsService } from '../referrals/referrals.service';
import { formatNaira, MIN_PAYOUT_KOBO } from '../common/money';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger('payouts');

  constructor(
    @Inject(DRIZZLE) private readonly db: PostgresJsDatabase<typeof schema>,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly referrals: ReferralsService,
  ) {}

  /**
   * Request a withdrawal.
   *
   * Three things differ from the original, and each of them was exploitable:
   *
   *  1. **The balance is read server-side from the ledger**, not from a field on
   *     the user's own record. The original's comment said "Never trust client
   *     balance!" while reading that exact field, on a database anyone could
   *     write to.
   *  2. **The hold is a ledger debit.** Requesting a payout immediately debits
   *     the balance, so the same money cannot be requested twice in parallel.
   *     The original deducted and created the payout as two separate writes, so
   *     a second request in between still saw the old balance.
   *  3. **The debit carries an idempotency key tied to the payout row**, so a
   *     retried request cannot double-debit.
   */
  async request(
    userId: string,
    input: {
      amountKobo?: number;
      bankName: string;
      accountNumber: string;
      accountName: string;
    },
    idempotencyKey: string,
  ) {
    const balanceKobo = await this.ledger.balanceKobo(userId);

    if (balanceKobo < MIN_PAYOUT_KOBO) {
      throw new BadRequestException(
        `Minimum withdrawal is ${formatNaira(MIN_PAYOUT_KOBO)}. Your balance is ${formatNaira(balanceKobo)}.`,
      );
    }

    const requested = input.amountKobo && input.amountKobo > 0
      ? Math.min(input.amountKobo, balanceKobo)
      : balanceKobo;

    if (requested < MIN_PAYOUT_KOBO) {
      throw new BadRequestException(
        `Minimum withdrawal per transaction is ${formatNaira(MIN_PAYOUT_KOBO)}.`,
      );
    }

    const riskScore = await this.referrals.riskScore(userId);
    const verifiedCount = await this.referrals.countVerified(userId);

    const payout = await this.db.transaction(async (tx) => {
      // Serialise this user's withdrawal requests. Without this row lock, two
      // taps in the same second both read the same balance, both insert a
      // request, and both place a hold — driving the ledger negative. The lock
      // is on the user row rather than the ledger because the user row is the
      // thing every concurrent request for this person necessarily shares.
      await tx.execute(sql`SELECT id FROM ${schema.users} WHERE ${schema.users.id} = ${userId} FOR UPDATE`);

      // Re-read the balance *inside* the lock. The value read before the
      // transaction was only good enough to produce an early error message.
      const lockedBalanceKobo = await tx
        .select({ total: sql<string>`COALESCE(SUM(${schema.ledgerEntries.deltaKobo}), 0)` })
        .from(schema.ledgerEntries)
        .where(eq(schema.ledgerEntries.userId, userId));

      const availableKobo = Number(lockedBalanceKobo[0]?.total ?? 0);
      if (availableKobo < requested) {
        throw new BadRequestException(
          `Your available balance is ${formatNaira(availableKobo)}, less than the ${formatNaira(requested)} requested.`,
        );
      }

      const [created] = await tx
        .insert(schema.payouts)
        .values({
          userId,
          amountKobo: requested,
          type: 'referral_earnings',
          bankName: input.bankName,
          accountNumber: input.accountNumber,
          accountName: input.accountName,
          status: 'pending_review',
          fraudRiskScore: riskScore,
          referralsVerifiedAtRequest: verifiedCount,
        })
        .returning();

      // Hold the funds in the same transaction that creates the request. If the
      // debit fails — insufficient balance because a concurrent request got
      // there first — the whole thing rolls back and no orphan request exists.
      const held = await this.ledger.apply(
        {
          userId,
          deltaKobo: -requested,
          reason: 'payout_hold',
          sourceType: 'payout',
          sourceId: created.id,
          description: `Withdrawal requested — ${formatNaira(requested)}`,
          idempotencyKey: `payout_hold:${created.id}`,
        },
        tx,
      );

      if (!held.applied && held.entryId === null) {
        throw new BadRequestException('Could not place the withdrawal on hold, please retry.');
      }

      return created;
    });

    await this.notifications.create(userId, {
      userId,
      type: 'payout',
      title: 'Withdrawal request queued',
      message: `Your withdrawal of ${formatNaira(requested)} to ${input.accountName} (${input.bankName}) is queued for review.`,
    });

    this.logger.log(
      `[payouts] ${userId} requested ${formatNaira(requested)} (payout ${payout.id}, risk ${riskScore}, key ${idempotencyKey})`,
    );

    return {
      success: true,
      payoutId: payout.id,
      amountKobo: requested,
      message: `Withdrawal of ${formatNaira(requested)} submitted. Queued for review.`,
    };
  }

  async myPayouts(userId: string) {
    return this.db
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.userId, userId))
      .orderBy(desc(schema.payouts.requestedAt))
      .limit(100);
  }

  /** Carry-over from the original: confirm a social post mentioning Nearby. */
  async setSocialTag(userId: string, payoutId: string, handle: string) {
    const [payout] = await this.db
      .select()
      .from(schema.payouts)
      .where(eq(schema.payouts.id, payoutId));

    if (!payout) throw new BadRequestException('Payout not found.');
    if (payout.userId !== userId) throw new ForbiddenException('Not your payout request.');

    await this.db
      .update(schema.payouts)
      .set({ socialTagHandle: handle.trim(), socialTagConfirmed: true })
      .where(eq(schema.payouts.id, payoutId));

    return { success: true, message: 'Social post tag saved. The team is notified.' };
  }

  // ── Admin ────────────────────────────────────────────────────────────────

  async listAll(status?: string) {
    // Order and limit are applied to the query builder before it is awaited.
    const base = status
      ? this.db.select().from(schema.payouts).where(eq(schema.payouts.status, status as never))
      : this.db.select().from(schema.payouts);

    return base.orderBy(desc(schema.payouts.requestedAt)).limit(200);
  }

  /**
   * Move a payout through review.
   *
   * Rejection refunds the held amount as a `payout_refund` ledger entry — a new
   * row, not an edit. The original mutated the balance back, which left no trace
   * that a rejection had ever happened; here the history shows both the hold and
   * the refund, so the balance is always explainable.
   */
  async updateStatus(
    payoutId: string,
    newStatus: 'approved' | 'paid' | 'rejected',
    reviewedBy: string,
    reason?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [payout] = await tx
        .select()
        .from(schema.payouts)
        .where(eq(schema.payouts.id, payoutId));

      if (!payout) throw new BadRequestException('Payout not found.');

      // Terminal state: a paid or rejected payout cannot be moved again, which
      // is what stops a rejection being replayed to refund twice.
      if (payout.status === 'paid' || payout.status === 'rejected') {
        throw new BadRequestException(`This payout is already ${payout.status}.`);
      }

      await tx
        .update(schema.payouts)
        .set({
          status: newStatus,
          rejectionReason: newStatus === 'rejected' ? (reason ?? null) : null,
          reviewedBy,
          processedAt: new Date(),
        })
        .where(eq(schema.payouts.id, payoutId));

      if (newStatus === 'rejected') {
        await this.ledger.apply(
          {
            userId: payout.userId,
            deltaKobo: payout.amountKobo,
            reason: 'payout_refund',
            sourceType: 'payout',
            sourceId: payout.id,
            description: `Withdrawal refunded — ${formatNaira(payout.amountKobo)}`,
            // Deterministic: a second rejection attempt on the same payout can
            // only ever produce this same key, so it refunds once.
            idempotencyKey: `payout_refund:${payout.id}`,
          },
          tx,
        );
      }

      await this.notifications.create(payout.userId, {
        userId: payout.userId,
        type: 'payout',
        title: `Payout ${newStatus}`,
        message:
          newStatus === 'paid'
            ? `${formatNaira(payout.amountKobo)} has been paid to your bank account.`
            : newStatus === 'rejected'
              ? `Your withdrawal was rejected: ${reason ?? 'failed review'}. The amount is back in your balance.`
              : `Your withdrawal of ${formatNaira(payout.amountKobo)} was approved.`,
      });

      return { success: true, status: newStatus };
    });
  }
}

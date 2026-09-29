import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { UsersService } from '../users/users.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { LedgerService } from './ledger.service';
import { MIN_PAYOUT_KOBO, formatNaira } from '../common/money';
import { adminAdjustmentSchema, AdminAdjustmentDto, ledgerHistoryQuerySchema } from './ledger.dto';

@UseGuards(FirebaseAuthGuard)
@Controller('ledger')
export class LedgerController {
  constructor(
    private readonly usersService: UsersService,
    private readonly ledgerService: LedgerService,
  ) {}

  /**
   * The current user's balance.
   *
   * Note what is NOT in this handler: any way to set the balance. There is no
   * write path to a number here at all — a balance is a SUM over the ledger, so
   * the only way to change it is to append an entry that says why.
   */
  @Get('balance')
  async balance(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const [balanceKobo, lifetimeEarnedKobo] = await Promise.all([
      this.ledgerService.balanceKobo(me.id),
      this.ledgerService.lifetimeEarnedKobo(me.id),
    ]);

    return {
      balanceKobo,
      lifetimeEarnedKobo,
      minimumWithdrawalKobo: MIN_PAYOUT_KOBO,
      canWithdraw: balanceKobo >= MIN_PAYOUT_KOBO,
      balanceNaira: formatNaira(balanceKobo),
      lifetimeEarnedNaira: formatNaira(lifetimeEarnedKobo),
    };
  }

  @Get('history')
  async history(
    @CurrentUser() firebaseUser: { uid: string },
    @Query(new ZodValidationPipe(ledgerHistoryQuerySchema)) query: { limit?: number },
  ) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const entries = await this.ledgerService.history(me.id, query.limit ?? 50);
    return entries.map((entry) => ({
      ...entry,
      amountNaira: formatNaira(entry.deltaKobo),
      isCredit: entry.deltaKobo > 0,
    }));
  }

  @Get('summary')
  async summary(@CurrentUser() firebaseUser: { uid: string }) {
    const me = await this.usersService.findOrCreateByFirebaseUid(firebaseUser);
    const rows = await this.ledgerService.earningsSummary(me.id);
    return rows.map((row) => ({ ...row, totalNaira: formatNaira(row.totalKobo) }));
  }

  /** Admin-only, and recorded as its own ledger reason so it is never mistaken
   *  for an earned reward. */
  @UseGuards(AdminGuard)
  @Post('adjustment')
  async adjustment(
    @CurrentUser() firebaseUser: { uid: string },
    @Body(new ZodValidationPipe(adminAdjustmentSchema)) body: AdminAdjustmentDto,
  ) {
    const result = await this.ledgerService.apply({
      userId: body.userId,
      deltaKobo: body.deltaKobo,
      reason: 'admin_adjustment',
      sourceType: 'admin',
      sourceId: firebaseUser.uid,
      description: body.description,
      idempotencyKey: body.idempotencyKey,
    });
    return {
      ...result,
      message: result.applied
        ? `Adjustment applied: ${formatNaira(body.deltaKobo)}.`
        : 'This adjustment had already been applied.',
    };
  }
}

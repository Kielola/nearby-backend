import { z } from 'zod';

export const ledgerHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type LedgerHistoryQueryDto = z.infer<typeof ledgerHistoryQuerySchema>;

/**
 * Admin-only manual adjustment. Every field is required, including the reason
 * and an idempotency key — an unexplained credit with no way to retry it safely
 * is exactly the kind of row that makes a ledger untrustworthy.
 */
export const adminAdjustmentSchema = z.object({
  userId: z.string().uuid(),
  deltaKobo: z.number().int().refine((v) => v !== 0, 'Adjustment cannot be zero.'),
  description: z.string().min(3).max(300),
  idempotencyKey: z.string().min(3).max(200),
});
export type AdminAdjustmentDto = z.infer<typeof adminAdjustmentSchema>;

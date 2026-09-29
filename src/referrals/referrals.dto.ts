import { z } from 'zod';

export const attributeReferralSchema = z.object({
  /** The code from the invite link. Case-insensitive. */
  code: z.string().min(3).max(32),
  /** Optional device fingerprint, computed client-side for abuse review. */
  deviceHash: z.string().max(128).optional(),
});
export type AttributeReferralDto = z.infer<typeof attributeReferralSchema>;

export const logClickSchema = z.object({
  code: z.string().min(3).max(32),
});
export type LogClickDto = z.infer<typeof logClickSchema>;

export const markFraudSchema = z.object({
  reason: z.string().min(3).max(300),
});
export type MarkFraudDto = z.infer<typeof markFraudSchema>;

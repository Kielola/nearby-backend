import { z } from 'zod';

export const redeemTreasureSchema = z.object({
  code: z.string().min(3).max(64),
  /** Optional. Sent when the client has a usable fix; when it is absent the
   *  proximity check is skipped rather than failing the claim, so a member with
   *  location problems is never locked out of a code they physically found. */
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});
export type RedeemTreasureDto = z.infer<typeof redeemTreasureSchema>;

export const setTreasureLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(50).max(50_000),
});
export type SetTreasureLocationDto = z.infer<typeof setTreasureLocationSchema>;

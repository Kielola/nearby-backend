import { z } from 'zod';

export const applyInfluencerSchema = z
  .object({
    instagram: z.string().max(80).optional(),
    tiktok: z.string().max(80).optional(),
    twitter: z.string().max(80).optional(),
    youtube: z.string().max(80).optional(),
    customCode: z.string().min(3).max(32),
    campaignName: z.string().min(2).max(80),
  })
  // At least one platform handle, so an application is reviewable. The original
  // accepted an application with no links at all.
  .refine(
    (v) => Boolean(v.instagram || v.tiktok || v.twitter || v.youtube),
    'Add at least one social handle so we can review your application.',
  );
export type ApplyInfluencerDto = z.infer<typeof applyInfluencerSchema>;

export const influencerStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reason: z.string().min(3).max(300).optional(),
});
export type InfluencerStatusDto = z.infer<typeof influencerStatusSchema>;

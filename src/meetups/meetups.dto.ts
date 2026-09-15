import { z } from 'zod';

export const scheduleMeetupSchema = z.object({
  otherUserId: z.string().uuid(),
  location: z.string().max(500).optional(),
  scheduledAt: z.string().datetime().optional(),
});
export type ScheduleMeetupDto = z.infer<typeof scheduleMeetupSchema>;

export const rateMeetupSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});
export type RateMeetupDto = z.infer<typeof rateMeetupSchema>;

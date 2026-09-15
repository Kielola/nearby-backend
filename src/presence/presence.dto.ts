import { z } from 'zod';

export const presenceStatusSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(200),
});
export type PresenceStatusDto = z.infer<typeof presenceStatusSchema>;

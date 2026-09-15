import { z } from 'zod';

export const createNotificationSchema = z.object({
  userId: z.string().uuid(), // recipient
  type: z.string().min(1).max(50),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(1000),
});
export type CreateNotificationDto = z.infer<typeof createNotificationSchema>;

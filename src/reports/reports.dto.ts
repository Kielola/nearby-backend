import { z } from 'zod';

export const createReportSchema = z.object({
  reportedUserId: z.string().uuid(),
  reason: z.string().min(3).max(1000),
});
export type CreateReportDto = z.infer<typeof createReportSchema>;

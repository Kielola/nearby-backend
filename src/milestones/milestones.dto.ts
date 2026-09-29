import { z } from 'zod';

export const claimMilestoneSchema = z.object({
  milestoneKey: z.string().min(1).max(64),
});
export type ClaimMilestoneDto = z.infer<typeof claimMilestoneSchema>;

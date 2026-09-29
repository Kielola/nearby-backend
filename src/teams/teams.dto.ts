import { z } from 'zod';

export const createTeamSchema = z.object({
  name: z.string().min(2).max(60),
});
export type CreateTeamDto = z.infer<typeof createTeamSchema>;

export const joinTeamSchema = z.object({
  code: z.string().min(3).max(16),
});
export type JoinTeamDto = z.infer<typeof joinTeamSchema>;

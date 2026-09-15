import { z } from 'zod';

export const setVisibilitySchema = z.object({
  isVisibleOnRadar: z.boolean(),
  radarVisibilityMode: z.enum(['everyone', 'friends', 'hidden']),
});
export type SetVisibilityDto = z.infer<typeof setVisibilitySchema>;

import { z } from 'zod';

export const setProfilePictureSchema = z.object({
  url: z.string().url(),
});
export type SetProfilePictureDto = z.infer<typeof setProfilePictureSchema>;

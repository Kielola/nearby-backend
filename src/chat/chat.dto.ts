import { z } from 'zod';

export const startConversationSchema = z.object({
  otherUserId: z.string().uuid(),
});
export type StartConversationDto = z.infer<typeof startConversationSchema>;

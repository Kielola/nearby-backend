import { z } from 'zod';

export const createPostSchema = z.object({
  caption: z.string().max(2000).optional(),
  mediaUrl: z.string().url().optional(),
  mediaType: z.enum(['image', 'video']).optional(),
});
export type CreatePostDto = z.infer<typeof createPostSchema>;

export const createHighlightSchema = z.object({
  mediaUrl: z.string().url(),
  mediaType: z.enum(['image', 'video']),
  caption: z.string().max(500).optional(),
});
export type CreateHighlightDto = z.infer<typeof createHighlightSchema>;

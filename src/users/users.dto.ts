import { z } from 'zod';

// PATCH /me — partial profile update. Every field optional so the client
// can send just what changed (e.g. only the location label when GPS moves).
export const updateMeSchema = z
  .object({
    displayName: z.string().min(1).max(60).optional(),
    bio: z.string().max(500).optional(),
    avatarUrl: z.string().url().max(1000).optional(),
    streetName: z.string().max(160).optional(),
    customStatus: z.string().max(120).optional(),
    // Sent alongside streetName so the server can store how precise the
    // underlying fix was. Lets us tell "real street" apart from
    // "coarse label we shouldn't show to strangers".
    locationAccuracy: z.number().min(0).max(100000).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, {
    message: 'Send at least one field to update',
  });

export type UpdateMeDto = z.infer<typeof updateMeSchema>;

// GET /users/:id returns a deliberately narrow public projection. Never
// latitude/longitude — those are the user's home address and are only
// ever exposed through /radar/nearby, which applies radius + visibility
// + relationship rules and returns a rounded distance instead.
export const publicProfileSelect = {
  id: true,
  displayName: true,
  avatarUrl: true,
  bio: true,
  streetName: true,
  customStatus: true,
  createdAt: true,
} as const;

// POST /me/terms-acceptance
//
// The client sends ONLY the version string it displayed. The server stamps the
// time itself. Accepting a client-supplied timestamp would let anyone claim
// they agreed at some earlier, more convenient moment — which is precisely the
// question this record exists to answer.
export const acceptTermsSchema = z.object({
  version: z
    .string()
    .min(1)
    .max(40)
    // Matches the version identifiers used by the frontend's terms document
    // (e.g. "2026-08-30"). Constrained so a client cannot stuff arbitrary text
    // into the column.
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, 'version must look like YYYY-MM-DD'),
});

export type AcceptTermsDto = z.infer<typeof acceptTermsSchema>;

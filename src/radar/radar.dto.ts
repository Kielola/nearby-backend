import { z } from 'zod';

export const updateLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type UpdateLocationDto = z.infer<typeof updateLocationSchema>;

// Query-string values arrive as strings, so coerce before validating.
// 0.1 km minimum prevents a radius of 0 / negative, and the 50 km ceiling
// stops a single request from asking for (and receiving) the whole table.
export const nearbyQuerySchema = z.object({
  radiusKm: z.coerce.number().min(0.1).max(50).default(5),
});
export type NearbyQueryDto = z.infer<typeof nearbyQuerySchema>;

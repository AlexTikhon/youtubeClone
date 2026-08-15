import { z } from 'zod';

export const processVideoJobSchema = z.object({
  schemaVersion: z.literal(1),
  videoId: z.string().uuid(),
  originalAssetId: z.string().uuid(),
  correlationId: z.string().min(1).max(100),
});

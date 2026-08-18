import { z } from 'zod';

export const startUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.literal('video/mp4'),
  sizeBytes: z.coerce
    .number()
    .finite()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
});

export type StartUploadInput = z.infer<typeof startUploadSchema>;

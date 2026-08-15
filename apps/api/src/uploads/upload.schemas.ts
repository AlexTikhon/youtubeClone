import { z } from 'zod';

export const startUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.literal('video/mp4'),
  sizeBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024),
});

export type StartUploadInput = z.infer<typeof startUploadSchema>;

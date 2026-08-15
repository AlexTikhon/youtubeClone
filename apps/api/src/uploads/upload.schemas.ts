import { z } from 'zod';

export const startUploadSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z
    .string()
    .regex(/^video\/[a-z0-9.+-]+$/i, 'Only video content types are accepted'),
  sizeBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024 * 1024),
});

export type StartUploadInput = z.infer<typeof startUploadSchema>;

import { z } from 'zod';

import { VIDEO_VISIBILITIES } from '@youtube-clone/types';

export const createVideoSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5_000).optional(),
  visibility: z.enum(VIDEO_VISIBILITIES).default('PRIVATE'),
});

export type CreateVideoInput = z.infer<typeof createVideoSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const cursorPaginationSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type CursorPaginationInput = z.infer<typeof cursorPaginationSchema>;

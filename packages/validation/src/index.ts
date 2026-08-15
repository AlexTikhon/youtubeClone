import { z } from 'zod';

import { VIDEO_VISIBILITIES } from '@youtube-clone/types';

export const createVideoSchema = z.object({
  channelId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5_000).optional(),
  visibility: z.enum(VIDEO_VISIBILITIES).default('PRIVATE'),
});

export type CreateVideoInput = z.infer<typeof createVideoSchema>;

export const cursorPaginationSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type CursorPaginationInput = z.infer<typeof cursorPaginationSchema>;

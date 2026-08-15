import { z } from 'zod';

import { VIDEO_VISIBILITIES } from '@youtube-clone/types';

export const createVideoSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(5_000).optional(),
  visibility: z.enum(VIDEO_VISIBILITIES).default('PRIVATE'),
});

export type CreateVideoInput = z.infer<typeof createVideoSchema>;

export const updateVideoSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(5_000).nullable().optional(),
    visibility: z.enum(VIDEO_VISIBILITIES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one editable field is required',
  });
export type UpdateVideoInput = z.infer<typeof updateVideoSchema>;

export const createCommentSchema = z.object({
  content: z.string().trim().min(1).max(2_000),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const recordViewSchema = z.object({
  watchedSeconds: z.number().finite().nonnegative(),
});
export type RecordViewInput = z.infer<typeof recordViewSchema>;

export const updateHistorySchema = z.object({
  positionSeconds: z.number().finite().nonnegative(),
});
export type UpdateHistoryInput = z.infer<typeof updateHistorySchema>;

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

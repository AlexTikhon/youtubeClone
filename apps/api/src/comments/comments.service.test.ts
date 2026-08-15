import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../infrastructure/http/app-error.js';
import { CommentsService } from './comments.service.js';

describe('CommentsService authorization', () => {
  it('cannot comment when watch authorization rejects the video', async () => {
    const videos = {
      assertWatchAccess: vi
        .fn()
        .mockRejectedValue(
          new AppError('VIDEO_NOT_FOUND', 'Video was not found', 404),
        ),
    };
    const prisma = { comment: { create: vi.fn() } };
    const service = new CommentsService(prisma as never, videos as never);
    await expect(
      service.create('private-video', 'viewer', { content: 'No access' }),
    ).rejects.toMatchObject({ code: 'VIDEO_NOT_FOUND' });
    expect(prisma.comment.create).not.toHaveBeenCalled();
  });

  it('allows the video owner to delete another author comment', async () => {
    const prisma = {
      comment: {
        findUnique: vi.fn().mockResolvedValue({
          authorId: 'author',
          video: { channel: { ownerId: 'owner' } },
        }),
        delete: vi.fn().mockResolvedValue({}),
      },
    };
    const service = new CommentsService(prisma as never, {} as never);
    await expect(service.delete('comment', 'owner')).resolves.toEqual({
      deleted: true,
    });
    expect(prisma.comment.delete).toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { HistoryService } from './history.service.js';

describe('HistoryService view deduplication', () => {
  it('does not write below the meaningful-watch threshold', async () => {
    const prisma = {
      videoView: { createMany: vi.fn(), count: vi.fn().mockResolvedValue(4) },
    };
    const service = new HistoryService(
      prisma as never,
      {
        assertWatchAccess: vi.fn().mockResolvedValue({ durationSeconds: 100 }),
      } as never,
    );
    await expect(service.recordView('video', 'user', 5)).resolves.toEqual({
      counted: false,
      viewsCount: 4,
    });
    expect(prisma.videoView.createMany).not.toHaveBeenCalled();
  });

  it('reports duplicates from the unique day bucket as not counted', async () => {
    const prisma = {
      videoView: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(1),
      },
    };
    const service = new HistoryService(
      prisma as never,
      {
        assertWatchAccess: vi.fn().mockResolvedValue({ durationSeconds: 100 }),
      } as never,
    );
    await expect(service.recordView('video', 'user', 10)).resolves.toEqual({
      counted: false,
      viewsCount: 1,
    });
  });

  it('returns a watched unlisted video without requiring a publication date', async () => {
    const watchedAt = new Date('2026-08-16T10:00:00.000Z');
    const prisma = {
      watchHistory: {
        findMany: vi.fn().mockResolvedValue([
          {
            videoId: '11111111-1111-4111-8111-111111111111',
            lastPositionSeconds: 12,
            lastWatchedAt: watchedAt,
            video: {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'Direct link',
              durationSeconds: 30,
              publishedAt: null,
              channel: {
                id: '22222222-2222-4222-8222-222222222222',
                name: 'Creator',
                handle: 'creator',
                avatarUrl: null,
              },
              _count: { views: 1 },
            },
          },
        ]),
      },
    };
    const service = new HistoryService(prisma as never, {} as never);

    await expect(service.list('user', undefined, 20)).resolves.toMatchObject({
      data: [{ video: { publishedAt: null }, lastPositionSeconds: 12 }],
    });
  });
});

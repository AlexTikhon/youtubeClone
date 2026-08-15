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
});

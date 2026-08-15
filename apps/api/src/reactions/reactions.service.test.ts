import { describe, expect, it, vi } from 'vitest';
import { ReactionsService } from './reactions.service.js';
describe('ReactionsService', () => {
  it('uses database upsert so repeated likes remain idempotent', async () => {
    const prisma = {
      videoLike: {
        upsert: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(1),
      },
    };
    const service = new ReactionsService(
      prisma as never,
      { assertWatchAccess: vi.fn() } as never,
    );
    await service.like('video', 'user');
    await service.like('video', 'user');
    expect(prisma.videoLike.upsert).toHaveBeenCalledTimes(2);
    expect(await service.like('video', 'user')).toEqual({
      liked: true,
      likesCount: 1,
    });
  });
  it('uses deleteMany so repeated unlike is safe', async () => {
    const prisma = {
      videoLike: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const service = new ReactionsService(
      prisma as never,
      { assertWatchAccess: vi.fn() } as never,
    );
    await expect(service.unlike('video', 'user')).resolves.toEqual({
      liked: false,
      likesCount: 0,
    });
  });
});

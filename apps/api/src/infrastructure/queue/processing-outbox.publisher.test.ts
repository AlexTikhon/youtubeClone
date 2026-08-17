import { describe, expect, it, vi } from 'vitest';

import { ProcessingOutboxPublisher } from './processing-outbox.publisher.js';
import { processingJobId } from './video-processing-queue.port.js';

const event = {
  id: 'event-id',
  videoId: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
  generation: 2,
  originalAssetId: '0ab359e2-d72a-44b3-a797-70f5f00936e4',
  correlationId: 'request-id',
  createdAt: new Date(),
  publishedAt: null,
  attempts: 0,
  lastError: null,
};

describe('ProcessingOutboxPublisher', () => {
  it('uses a deterministic generation-specific BullMQ identity', () => {
    expect(processingJobId(event)).toBe(`video-${event.videoId}-generation-2`);
  });

  it('publishes an event once and marks it after queue acceptance', async () => {
    const prisma = {
      processingOutbox: {
        findMany: vi.fn().mockResolvedValueOnce([event]).mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const publisher = new ProcessingOutboxPublisher(
      prisma as never,
      queue as never,
    );

    await publisher.publishPending();
    await publisher.publishPending();

    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2 }),
    );
    expect(prisma.processingOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: event.id, publishedAt: null },
        data: expect.objectContaining({ publishedAt: expect.any(Date) }),
      }),
    );
    expect(prisma.processingOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publishedAt: null } }),
    );
  });

  it('leaves a temporary queue failure unpublished and recovers later', async () => {
    const prisma = {
      processingOutbox: {
        findMany: vi.fn().mockResolvedValue([event]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const queue = {
      enqueue: vi
        .fn()
        .mockRejectedValueOnce(new Error('Redis unavailable'))
        .mockResolvedValueOnce(undefined),
    };
    const publisher = new ProcessingOutboxPublisher(
      prisma as never,
      queue as never,
    );

    await publisher.publishPending();
    await publisher.publishPending();

    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(prisma.processingOutbox.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: expect.stringContaining('will retry'),
        }),
      }),
    );
    expect(prisma.processingOutbox.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ publishedAt: expect.any(Date) }),
      }),
    );
  });

  it('contains a temporary PostgreSQL scan failure for the next interval', async () => {
    const prisma = {
      processingOutbox: {
        findMany: vi.fn().mockRejectedValue(new Error('database unavailable')),
      },
    };
    const publisher = new ProcessingOutboxPublisher(
      prisma as never,
      { enqueue: vi.fn() } as never,
    );

    await expect(publisher.publishPending()).resolves.toBeUndefined();
  });

  it('removes only published events older than the retention window', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const publisher = new ProcessingOutboxPublisher(
      { processingOutbox: { deleteMany } } as never,
      {} as never,
    );
    const now = new Date('2026-08-17T12:00:00.000Z');

    await publisher.cleanupPublished(now);

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        publishedAt: { lt: new Date('2026-07-18T12:00:00.000Z') },
      },
    });
  });
});

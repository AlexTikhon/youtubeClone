import { describe, expect, it, vi } from 'vitest';

import { ProcessingReconciler } from './processing-reconciler.js';

const candidate = {
  outboxId: 'outbox-id',
  videoId: 'video-id',
  generation: 2,
  originalAssetId: 'asset-id',
  correlationId: 'request-id',
  recoveryAttempts: 0,
  processingAttemptId: 'dead-attempt',
};

function createReconciler(input: {
  candidates?: unknown[];
  executeResults?: number[];
  jobState?: string;
  getState?: ReturnType<typeof vi.fn>;
}) {
  const results = [...(input.executeResults ?? [1, 1, 1])];
  const prisma = {
    $queryRawUnsafe: vi.fn().mockResolvedValue(input.candidates ?? [candidate]),
    $executeRawUnsafe: vi.fn(async () => results.shift() ?? 1),
    processingOutbox: { update: vi.fn().mockResolvedValue({}) },
  };
  const queue = {
    getState:
      input.getState ?? vi.fn().mockResolvedValue(input.jobState ?? 'missing'),
    requeue: vi.fn().mockResolvedValue(undefined),
  };
  const storage = { deletePrefix: vi.fn().mockResolvedValue(undefined) };
  const reconciler = new ProcessingReconciler(
    prisma as never,
    queue as never,
    storage as never,
    { S3_BUCKET_STREAMS: 'streams', S3_BUCKET_THUMBNAILS: 'thumbs' } as never,
    { maxRecoveries: 3 },
  );
  return { reconciler, prisma, queue, storage };
}

describe('ProcessingReconciler decisions', () => {
  it('does nothing beyond the inspection claim for a job that is queued or active', async () => {
    for (const jobState of ['queued', 'active']) {
      const { reconciler, prisma, queue } = createReconciler({ jobState });

      const summary = await reconciler.reconcile();

      expect(summary).toMatchObject({ inspected: 1, healthy: 1 });
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      expect(queue.requeue).not.toHaveBeenCalled();
    }
  });

  it('skips a generation another instance already claimed', async () => {
    const { reconciler, queue } = createReconciler({ executeResults: [0] });

    const summary = await reconciler.reconcile();

    expect(summary).toMatchObject({ inspected: 0, skipped: 1 });
    expect(queue.getState).not.toHaveBeenCalled();
  });

  it('revokes the expired owner before re-publishing, then counts the recovery', async () => {
    const { reconciler, prisma, queue } = createReconciler({
      jobState: 'missing',
    });

    const summary = await reconciler.reconcile();

    expect(summary.republished).toBe(1);
    const statements = prisma.$executeRawUnsafe.mock.calls.map(
      ([sql]) => sql as string,
    );
    expect(statements[1]).toContain('"processingAttemptId" = NULL');
    expect(queue.requeue).toHaveBeenCalledWith({
      schemaVersion: 1,
      videoId: 'video-id',
      originalAssetId: 'asset-id',
      generation: 2,
      correlationId: 'request-id',
    });
    expect(prisma.processingOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-id' },
      data: { recoveryAttempts: { increment: 1 } },
    });
  });

  it('does not re-publish when a live attempt appeared after the scan', async () => {
    const { reconciler, queue, prisma } = createReconciler({
      jobState: 'missing',
      executeResults: [1, 0],
    });

    const summary = await reconciler.reconcile();

    expect(summary.republished).toBe(0);
    expect(queue.requeue).not.toHaveBeenCalled();
    expect(prisma.processingOutbox.update).not.toHaveBeenCalled();
  });

  it('fails a terminally failed job and removes only the dead attempt output', async () => {
    const { reconciler, storage } = createReconciler({ jobState: 'failed' });

    const summary = await reconciler.reconcile();

    expect(summary.failed).toBe(1);
    expect(storage.deletePrefix).toHaveBeenCalledWith(
      'streams',
      'videos/video-id/generations/2/attempts/dead-attempt/',
    );
    expect(storage.deletePrefix).toHaveBeenCalledWith(
      'thumbs',
      'videos/video-id/generations/2/attempts/dead-attempt/',
    );
  });

  it('stops re-publishing after the bounded number of recoveries', async () => {
    const { reconciler, queue } = createReconciler({
      jobState: 'missing',
      candidates: [{ ...candidate, recoveryAttempts: 3 }],
    });

    const summary = await reconciler.reconcile();

    expect(summary.failed).toBe(1);
    expect(queue.requeue).not.toHaveBeenCalled();
  });

  it('keeps reconciling other generations when one inspection fails', async () => {
    const getState = vi
      .fn()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce('queued');
    const { reconciler } = createReconciler({
      getState,
      candidates: [candidate, { ...candidate, outboxId: 'second' }],
    });

    const summary = await reconciler.reconcile();

    expect(summary.healthy).toBe(1);
  });

  it('survives a database outage during the scan', async () => {
    const { reconciler, prisma } = createReconciler({});
    prisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('db down'));

    await expect(reconciler.reconcile()).resolves.toMatchObject({
      inspected: 0,
    });
  });
});

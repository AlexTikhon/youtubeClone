import { describe, expect, it, vi } from 'vitest';

import { WorkerHealthService } from './worker-health.service.js';

describe('WorkerHealthService readiness', () => {
  it('requires PostgreSQL, Redis/BullMQ, object storage, FFmpeg, and ffprobe', async () => {
    const database = {
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    };
    const worker = { checkReady: vi.fn().mockResolvedValue(undefined) };
    const mediaTools = { checkReady: vi.fn().mockResolvedValue(undefined) };
    const storage = { checkReady: vi.fn().mockResolvedValue(undefined) };
    const health = new WorkerHealthService(
      database as never,
      worker as never,
      mediaTools as never,
      storage as never,
    );

    await expect(health.readiness()).resolves.toMatchObject({
      ready: true,
      body: { status: 'ok', service: 'worker' },
    });
  });

  it('reports degraded readiness without failing liveness semantics', async () => {
    const health = new WorkerHealthService(
      {
        $queryRaw: vi.fn().mockRejectedValue(new Error('database down')),
      } as never,
      { checkReady: vi.fn().mockResolvedValue(undefined) } as never,
      { checkReady: vi.fn().mockResolvedValue(undefined) } as never,
      { checkReady: vi.fn().mockResolvedValue(undefined) } as never,
    );

    await expect(health.readiness()).resolves.toMatchObject({
      ready: false,
      body: {
        status: 'degraded',
        dependencies: { postgres: { status: 'down' } },
      },
    });
  });
});

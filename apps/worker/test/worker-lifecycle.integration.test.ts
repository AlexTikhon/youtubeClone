import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { workerEnvironment } from '../src/config.js';
import { StorageService } from '../src/storage.service.js';
import { VideoProcessingPipeline } from '../src/video-processing.pipeline.js';
import { VideoWorkerService } from '../src/video-worker.service.js';
import {
  cleanupFixtures,
  createUploadedVideo,
  fakeMediaTools,
  prisma,
  sleep,
  storage,
} from './attempt-support.js';

/**
 * Real BullMQ + Redis, real PostgreSQL, real MinIO, and a storage endpoint that
 * hangs on purpose. Proves cancelled work frees its worker slot and that
 * shutdown is bounded.
 */
const blackHoles: Array<{ close: () => Promise<void> }> = [];
const queues: Queue[] = [];
const services: VideoWorkerService[] = [];
const queueName = `video-processing-lifecycle-${Date.now()}`;
const connection = {
  url: workerEnvironment.REDIS_URL,
  maxRetriesPerRequest: null,
};

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
});

afterEach(async () => {
  for (const service of services.splice(0))
    await service.onApplicationShutdown();
  for (const queue of queues.splice(0)) {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  }
  await Promise.all(blackHoles.splice(0).map((hole) => hole.close()));
});

afterAll(async () => {
  await cleanupFixtures();
});

async function startBlackHole() {
  const sockets = new Set<Socket>();
  let connected = 0;
  let dropped = 0;
  const server: Server = createServer(() => undefined);
  server.on('connection', (socket) => {
    connected += 1;
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      dropped += 1;
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const hole = {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get connected() {
      return connected;
    },
    get dropped() {
      return dropped;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  blackHoles.push(hole);
  return hole;
}

/**
 * Routes one video's storage traffic to a socket that never answers; every
 * other video uses the real MinIO-backed service. Its cleanup is routed there
 * too, so the bounded-cleanup path is exercised against a hung endpoint.
 */
function selectiveStorage(
  blocked: { videoId: string; objectKey: string },
  blackHoleEndpoint: string,
): StorageService {
  const hung = new StorageService();
  (hung as unknown as { client: S3Client }).client = new S3Client({
    endpoint: blackHoleEndpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
  const pick = (videoId: string) =>
    videoId === blocked.videoId ? hung : storage;
  return {
    download: (...args: Parameters<StorageService['download']>) =>
      (args[1] === blocked.objectKey ? hung : storage).download(...args),
    uploadThumbnail: (...args: Parameters<StorageService['uploadThumbnail']>) =>
      storage.uploadThumbnail(...args),
    uploadHls: (...args: Parameters<StorageService['uploadHls']>) =>
      storage.uploadHls(...args),
    removeAttempt: (...args: Parameters<StorageService['removeAttempt']>) =>
      pick(args[0]).removeAttempt(...args),
    removeObsoleteGenerated: (
      ...args: Parameters<StorageService['removeObsoleteGenerated']>
    ) => storage.removeObsoleteGenerated(...args),
  } as unknown as StorageService;
}

function createService(
  pipeline: VideoProcessingPipeline,
  options: ConstructorParameters<typeof VideoWorkerService>[1] = {},
) {
  const service = new VideoWorkerService(pipeline, {
    queueName,
    concurrency: 1,
    shutdownGraceMs: 300,
    settleTimeoutMs: 4_000,
    ...options,
  });
  services.push(service);
  return service;
}

function createQueue() {
  const queue = new Queue(queueName, { connection });
  queues.push(queue);
  return queue;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await sleep(50);
  }
}

describe('worker slot and shutdown', () => {
  it('frees the only worker slot when a blocked attempt is cancelled at its deadline', async () => {
    const blocked = await createUploadedVideo();
    const healthy = await createUploadedVideo();
    const blackHole = await startBlackHole();
    const pipeline = new VideoProcessingPipeline(
      prisma as never,
      selectiveStorage(blocked, blackHole.endpoint),
      fakeMediaTools() as never,
      { renewIntervalMs: 100, attemptMaxMs: 500, cleanupTimeoutMs: 500 },
    );
    const service = createService(pipeline);
    const queue = createQueue();
    await queue.add('process', blocked.job, { attempts: 1 });
    await queue.add('process', healthy.job, { attempts: 1 });
    service.onApplicationBootstrap();

    // With concurrency 1 the second video can only run once the first slot is
    // free, i.e. once the blocked request was actually torn down.
    const ready = await waitFor(async () => {
      const row = await prisma.video.findUniqueOrThrow({
        where: { id: healthy.videoId },
      });
      return row.status === 'READY' ? row : undefined;
    });

    expect(ready.committedAttemptId).toBeTruthy();
    expect(blackHole.dropped).toBeGreaterThanOrEqual(1);
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: blocked.videoId } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      failureReason: 'Video processing timed out',
      processingAttemptId: null,
    });
  });

  it('shuts down within its bounds while an attempt is blocked, and hands the generation back', async () => {
    const blocked = await createUploadedVideo();
    const blackHole = await startBlackHole();
    const pipeline = new VideoProcessingPipeline(
      prisma as never,
      selectiveStorage(blocked, blackHole.endpoint),
      fakeMediaTools() as never,
      // The deadline is far away: only shutdown can cancel this attempt.
      { renewIntervalMs: 100, attemptMaxMs: 600_000, cleanupTimeoutMs: 500 },
    );
    const service = createService(pipeline);
    const queue = createQueue();
    await queue.add('process', blocked.job, { attempts: 3 });
    service.onApplicationBootstrap();
    await waitFor(async () => (blackHole.connected > 0 ? true : undefined));

    const startedAt = performance.now();
    await service.onApplicationShutdown();
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(250); // the grace period
    expect(elapsedMs).toBeLessThan(3_000); // settled by cancellation, not abandoned
    expect(blackHole.dropped).toBeGreaterThanOrEqual(1);
    const worker = (service as unknown as { worker: { isRunning(): boolean } })
      .worker;
    expect(worker.isRunning()).toBe(false);
    // Released, not failed: another worker can acquire it immediately.
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: blocked.videoId } }),
    ).resolves.toMatchObject({
      status: 'PROCESSING',
      processingAttemptId: null,
      processingLeaseExpiresAt: null,
      committedAttemptId: null,
    });
  });

  it('releases ownership when setup fails right after acquisition', async () => {
    const { videoId, job } = await createUploadedVideo();
    const pipeline = new VideoProcessingPipeline(
      prisma as never,
      storage,
      fakeMediaTools() as never,
      {
        renewIntervalMs: 50,
        workRoot: join(tmpdir(), 'youtube-clone-does-not-exist', 'nested'),
      },
    );
    const service = createService(pipeline);
    const process = (
      service as unknown as {
        process(job: unknown): Promise<void>;
      }
    ).process.bind(service);

    await expect(
      process({
        id: 'setup-failure-job',
        data: job,
        attemptsMade: 0,
        opts: { attempts: 3 },
        discard: () => undefined,
      }),
    ).rejects.toMatchObject({ retryable: true });

    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ).resolves.toMatchObject({
      status: 'PROCESSING',
      processingAttemptId: null,
      processingLeaseExpiresAt: null,
    });
  });
});

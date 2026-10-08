import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { workerEnvironment } from '../src/config.js';
import { acquireAttempt } from '../src/processing-lease.js';
import { StorageService } from '../src/storage.service.js';
import {
  blockUntilAborted,
  cleanupFixtures,
  createPipeline,
  createUploadedVideo,
  expireLease,
  fakeMediaTools,
  generatedKeys,
  prisma,
  s3,
  sleep,
} from './attempt-support.js';

/**
 * Real PostgreSQL, real MinIO, real sockets. The fakes only stand in for the
 * parts that cannot run here (FFmpeg) and they honour cancellation the way the
 * real implementations do: they stay blocked until the attempt signal aborts.
 */
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  await cleanupFixtures();
});

/** An S3 endpoint that accepts connections and never answers. */
async function startBlackHole() {
  const sockets = new Set<Socket>();
  let dropped = 0;
  const server: Server = createServer(() => undefined);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      dropped += 1;
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const handle = {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get dropped() {
      return dropped;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(handle);
  return handle;
}

function storageAgainst(endpoint: string): StorageService {
  const service = new StorageService();
  (service as unknown as { client: S3Client }).client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
  return service;
}

function settle(promise: Promise<unknown>) {
  return promise.then(
    () => ({ error: undefined as unknown }),
    (error: unknown) => ({ error }),
  );
}

async function leaseExpiry(videoId: string): Promise<number | undefined> {
  const row = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
  return row.processingLeaseExpiresAt?.getTime();
}

describe('attempt cancellation', () => {
  it('cancels a blocked storage download at the attempt deadline and still bounds its own cleanup', async () => {
    const { videoId, job } = await createUploadedVideo();
    const blackHole = await startBlackHole();
    const pipeline = createPipeline(
      { attemptMaxMs: 300, cleanupTimeoutMs: 400 },
      fakeMediaTools(),
      storageAgainst(blackHole.endpoint),
    );

    const startedAt = performance.now();
    const { error } = await settle(pipeline.execute('deadline-job', job));
    const elapsedMs = performance.now() - startedAt;

    expect(error).toMatchObject({
      name: 'AttemptDeadlineError',
      retryable: true,
      attemptId: expect.any(String),
    });
    // Deadline (300 ms) + bounded cleanup (400 ms): nothing waits on the
    // black hole indefinitely, and the execution has settled.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(blackHole.dropped).toBeGreaterThanOrEqual(1);
    // Still the recorded owner: the worker service decides release vs. fail.
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ).resolves.toMatchObject({
      status: 'PROCESSING',
      committedAttemptId: null,
    });
  });

  it('cancels active work when ownership is lost, without touching the new owner or its output', async () => {
    const { videoId, job } = await createUploadedVideo();
    let workStarted!: () => void;
    const started = new Promise<void>((resolve) => (workStarted = resolve));
    let workEnded = false;
    const pipeline = createPipeline(
      { renewIntervalMs: 100 },
      fakeMediaTools({
        blockRendition: async (signal) => {
          workStarted();
          try {
            await blockUntilAborted(signal);
          } finally {
            workEnded = true;
          }
        },
      }),
    );
    const running = settle(pipeline.execute('loser-job', job));
    await started;

    await expireLease(videoId);
    const newOwner = await acquireAttempt(prisma as never, {
      videoId,
      generation: 1,
      leaseSeconds: 60,
    });
    const newOwnerKey = `videos/${videoId}/generations/1/attempts/${newOwner}/hls/master.m3u8`;
    await s3.send(
      new PutObjectCommand({
        Bucket: workerEnvironment.S3_BUCKET_STREAMS,
        Key: newOwnerKey,
        Body: '#EXTM3U\n',
      }),
    );

    const { error } = await running;

    // Cancelled by the heartbeat noticing the takeover, not by the work ending.
    expect(workEnded).toBe(true);
    expect(error).toMatchObject({
      name: 'AttemptOwnershipLostError',
      retryable: false,
    });
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ).resolves.toMatchObject({
      status: 'PROCESSING',
      processingAttemptId: newOwner,
      committedAttemptId: null,
    });
    expect(await generatedKeys(videoId)).toEqual([newOwnerKey]);
  });

  it('stops working once renewals cannot be confirmed for a whole lease, and reports an interruption', async () => {
    const { videoId, job } = await createUploadedVideo();
    let calls = 0;
    // Acquisition works; every renewal after it fails like a dead connection.
    const flaky = new Proxy(prisma, {
      get(target, property) {
        if (property === '$executeRaw') {
          return (...args: unknown[]) => {
            calls += 1;
            if (calls > 1) return Promise.reject(new Error('connection lost'));
            return (target.$executeRaw as (...input: unknown[]) => unknown)(
              ...args,
            );
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PrismaClient;
    const pipeline = createPipeline(
      { leaseSeconds: 1, renewIntervalMs: 100 },
      fakeMediaTools({ blockRendition: blockUntilAborted }),
      undefined,
      flaky,
    );

    const startedAt = performance.now();
    const { error } = await settle(pipeline.execute('flaky-job', job));

    expect(error).toMatchObject({
      name: 'AttemptLeaseExpiredError',
      retryable: true,
      attemptId: expect.any(String),
    });
    expect(performance.now() - startedAt).toBeLessThan(4_000);
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ).resolves.toMatchObject({ status: 'PROCESSING' });
  });

  it('stops the heartbeat and settles when the temporary directory cannot be created', async () => {
    const { videoId, job } = await createUploadedVideo();
    const pipeline = createPipeline({
      renewIntervalMs: 50,
      leaseSeconds: 30,
      workRoot: join(tmpdir(), 'youtube-clone-does-not-exist', 'nested'),
    });

    const { error } = await settle(pipeline.execute('setup-job', job));

    expect(error).toMatchObject({
      retryable: true,
      attemptId: expect.any(String),
    });
    const expiryAfterFailure = await leaseExpiry(videoId);
    await sleep(500); // ten heartbeat periods
    // A leaked heartbeat would have pushed the lease further out.
    expect(await leaseExpiry(videoId)).toBe(expiryAfterFailure);
  });
});

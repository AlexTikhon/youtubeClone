import { randomUUID } from 'node:crypto';

import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { DelayedError, Queue, Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiEnvironmentSchema, parseEnvironment } from '@youtube-clone/config';
import {
  VIDEO_PROCESSING_QUEUE_NAME,
  type ProcessVideoJob,
} from '@youtube-clone/types';

import { BullVideoProcessingQueueAdapter } from '../src/infrastructure/queue/bull-video-processing-queue.adapter.js';
import { ProcessingOutboxPublisher } from '../src/infrastructure/queue/processing-outbox.publisher.js';
import { ProcessingReconciler } from '../src/infrastructure/queue/processing-reconciler.js';
import { processingJobId } from '../src/infrastructure/queue/video-processing-queue.port.js';
import { S3StorageAdapter } from '../src/infrastructure/storage/s3-storage.adapter.js';
import { VideosService } from '../src/videos/videos.service.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';

describe.skipIf(!enabled)('processing reconciliation integration', () => {
  const environment = parseEnvironment(apiEnvironmentSchema, process.env);
  const prisma = new PrismaClient();
  const queueAdapter = new BullVideoProcessingQueueAdapter(environment);
  const storage = new S3StorageAdapter(environment);
  const rawQueue = new Queue<ProcessVideoJob>(VIDEO_PROCESSING_QUEUE_NAME, {
    connection: { url: environment.REDIS_URL },
  });
  const s3 = new S3Client({
    endpoint: environment.S3_ENDPOINT,
    region: environment.S3_REGION,
    forcePathStyle: environment.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: environment.S3_ACCESS_KEY,
      secretAccessKey: environment.S3_SECRET_KEY,
    },
  });
  const options = {
    graceSeconds: 60,
    cooldownSeconds: 120,
    maxRecoveries: 3,
    batchSize: 25,
  };
  const suffix = randomUUID().slice(0, 8);
  const created = { userIds: [] as string[], videoIds: [] as string[] };
  const originalKeys: string[] = [];
  const reconciler = () =>
    new ProcessingReconciler(
      prisma as never,
      queueAdapter,
      storage,
      environment,
      options,
    );

  async function createStranded(input: {
    status?: 'UPLOADED' | 'PROCESSING';
    attemptId?: string | null;
    leaseOffsetSeconds?: number | null;
    recoveryAttempts?: number;
    publishedAgoSeconds?: number;
    generation?: number;
  }) {
    const id = randomUUID().slice(0, 8);
    const generation = input.generation ?? 1;
    const user = await prisma.user.create({
      data: {
        email: `reconcile-${suffix}-${id}@example.test`,
        username: `rec-${suffix}-${id}`,
        passwordHash: 'integration-only',
        channel: { create: { handle: `rec-${suffix}-${id}`, name: 'Recon' } },
      },
      include: { channel: true },
    });
    created.userIds.push(user.id);
    const objectKey = `integration/reconcile-${suffix}-${id}.mp4`;
    originalKeys.push(objectKey);
    const body = Buffer.from('original-bytes');
    await s3.send(
      new PutObjectCommand({
        Bucket: environment.S3_BUCKET_ORIGINALS,
        Key: objectKey,
        Body: body,
        ContentLength: body.length,
        ContentType: 'video/mp4',
      }),
    );
    const video = await prisma.video.create({
      data: {
        channelId: user.channel!.id,
        title: 'Reconciliation',
        status: input.status ?? 'UPLOADED',
        processingGeneration: generation,
        processingAttemptId: input.attemptId ?? null,
        processingLeaseExpiresAt:
          input.leaseOffsetSeconds === undefined ||
          input.leaseOffsetSeconds === null
            ? null
            : new Date(Date.now() + input.leaseOffsetSeconds * 1_000),
        assets: {
          create: {
            kind: 'ORIGINAL',
            bucket: environment.S3_BUCKET_ORIGINALS,
            objectKey,
            mimeType: 'video/mp4',
            sizeBytes: body.length,
          },
        },
      },
      include: { assets: true },
    });
    created.videoIds.push(video.id);
    const outbox = await prisma.processingOutbox.create({
      data: {
        videoId: video.id,
        generation,
        originalAssetId: video.assets[0]!.id,
        correlationId: `reconcile-${id}`,
        publishedAt: new Date(
          Date.now() - (input.publishedAgoSeconds ?? 600) * 1_000,
        ),
        recoveryAttempts: input.recoveryAttempts ?? 0,
      },
    });
    return { video, outbox, ref: { videoId: video.id, generation } };
  }

  async function jobFor(ref: { videoId: string; generation: number }) {
    return rawQueue.getJob(processingJobId(ref));
  }

  /**
   * Drives one job to a terminal BullMQ state with a real worker. Jobs that
   * belong to other tests are put back untouched, so the shared queue is not
   * disturbed.
   */
  async function finishJob(
    ref: { videoId: string; generation: number },
    outcome: 'fail' | 'complete',
  ) {
    const worker = new Worker<ProcessVideoJob>(
      VIDEO_PROCESSING_QUEUE_NAME,
      async (job, token) => {
        if (job.data.videoId !== ref.videoId) {
          await job.moveToDelayed(Date.now() + 10 * 60_000, token);
          throw new DelayedError();
        }
        if (outcome === 'fail')
          throw new Error('job stalled more than allowable limit');
        return 'done';
      },
      {
        connection: { url: environment.REDIS_URL, maxRetriesPerRequest: null },
      },
    );
    try {
      const expected = outcome === 'fail' ? 'failed' : 'completed';
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if ((await (await jobFor(ref))?.getState()) === expected) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`job did not reach ${expected}`);
    } finally {
      await worker.close();
    }
  }

  async function runJobToFailure(ref: { videoId: string; generation: number }) {
    await rawQueue.add(
      'process-video',
      {
        schemaVersion: 1,
        videoId: ref.videoId,
        originalAssetId: randomUUID(),
        generation: ref.generation,
        correlationId: 'stalled',
      },
      { jobId: processingJobId(ref), attempts: 1 },
    );
    await finishJob(ref, 'fail');
  }

  async function video(videoId: string) {
    return prisma.video.findUniqueOrThrow({ where: { id: videoId } });
  }

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    for (const videoId of created.videoIds) {
      for (const generation of [1, 2])
        await rawQueue
          .remove(processingJobId({ videoId, generation }))
          .catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    await Promise.all(
      originalKeys.map((Key) =>
        s3
          .send(
            new DeleteObjectCommand({
              Bucket: environment.S3_BUCKET_ORIGINALS,
              Key,
            }),
          )
          .catch(() => undefined),
      ),
    );
    await Promise.all([
      rawQueue.close(),
      queueAdapter.onApplicationShutdown(),
      prisma.$disconnect(),
    ]);
    storage.onApplicationShutdown();
    s3.destroy();
  });

  it('re-publishes a published event whose queue job is missing', async () => {
    const { ref, outbox } = await createStranded({});
    expect(await jobFor(ref)).toBeUndefined();

    await reconciler().reconcile();

    const job = await jobFor(ref);
    expect(job?.data).toMatchObject({
      videoId: ref.videoId,
      generation: 1,
      originalAssetId: outbox.originalAssetId,
      correlationId: outbox.correlationId,
    });
    await expect(
      prisma.processingOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
    ).resolves.toMatchObject({ recoveryAttempts: 1 });
    expect((await video(ref.videoId)).status).toBe('UPLOADED');
  });

  it('moves a terminal stalled BullMQ failure to FAILED so the owner can retry', async () => {
    const orphanedAttempt = randomUUID();
    const { ref, video: stranded } = await createStranded({
      status: 'PROCESSING',
      attemptId: orphanedAttempt,
      leaseOffsetSeconds: -300,
    });
    const orphanKey = `videos/${ref.videoId}/generations/1/attempts/${orphanedAttempt}/hls/master.m3u8`;
    await s3.send(
      new PutObjectCommand({
        Bucket: environment.S3_BUCKET_STREAMS,
        Key: orphanKey,
        Body: '#EXTM3U\n',
      }),
    );
    await runJobToFailure(ref);

    await reconciler().reconcile();

    await expect(video(ref.videoId)).resolves.toMatchObject({
      status: 'FAILED',
      processingAttemptId: null,
      processingLeaseExpiresAt: null,
      failureReason: expect.any(String),
    });
    // Only the dead attempt's unpublished objects are removed.
    const remaining = await s3.send(
      new ListObjectsV2Command({
        Bucket: environment.S3_BUCKET_STREAMS,
        Prefix: `videos/${ref.videoId}/`,
      }),
    );
    expect(remaining.Contents ?? []).toEqual([]);

    // The owner's explicit retry now works and publishes a new generation.
    const owner = await prisma.video.findUniqueOrThrow({
      where: { id: stranded.id },
      include: { channel: true },
    });
    const videos = new VideosService(prisma as never, storage, environment);
    await expect(
      videos.retryProcessing(stranded.id, owner.channel.ownerId, 'retry-test'),
    ).resolves.toMatchObject({ status: 'PROCESSING', processingGeneration: 2 });
  });

  it('never interrupts a valid active lease, even with no queue job', async () => {
    const attemptId = randomUUID();
    const { ref } = await createStranded({
      status: 'PROCESSING',
      attemptId,
      leaseOffsetSeconds: 600,
    });

    const summary = await reconciler().reconcile();

    expect(summary.republished).toBe(0);
    expect(await jobFor(ref)).toBeUndefined();
    await expect(video(ref.videoId)).resolves.toMatchObject({
      status: 'PROCESSING',
      processingAttemptId: attemptId,
    });
  });

  it('leaves a job that is legitimately waiting in the queue alone', async () => {
    const { ref, outbox } = await createStranded({});
    await queueAdapter.enqueue({
      schemaVersion: 1,
      videoId: ref.videoId,
      originalAssetId: outbox.originalAssetId,
      generation: 1,
      correlationId: outbox.correlationId,
    });

    await reconciler().reconcile();

    await expect(
      prisma.processingOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
    ).resolves.toMatchObject({ recoveryAttempts: 0 });
    expect((await video(ref.videoId)).status).toBe('UPLOADED');
  });

  it('creates one authoritative job for repeated and concurrent reconciliation', async () => {
    const { ref, outbox } = await createStranded({});

    await Promise.all([
      reconciler().reconcile(),
      reconciler().reconcile(),
      reconciler().reconcile(),
      reconciler().reconcile(),
    ]);
    await reconciler().reconcile();

    await expect(
      prisma.processingOutbox.findUniqueOrThrow({ where: { id: outbox.id } }),
    ).resolves.toMatchObject({ recoveryAttempts: 1 });
    const waiting = await rawQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(
      waiting.filter((job) => job.data.videoId === ref.videoId),
    ).toHaveLength(1);
  });

  it('replaces a retained completed job that no longer matches database state', async () => {
    const { ref, outbox } = await createStranded({});
    await rawQueue.add(
      'process-video',
      {
        schemaVersion: 1,
        videoId: ref.videoId,
        originalAssetId: outbox.originalAssetId,
        generation: 1,
        correlationId: 'old',
      },
      { jobId: processingJobId(ref), removeOnComplete: 100 },
    );
    await finishJob(ref, 'complete');
    expect(await (await jobFor(ref))?.getState()).toBe('completed');

    await reconciler().reconcile();

    const replaced = await jobFor(ref);
    expect(await replaced?.getState()).toBe('waiting');
    expect(replaced?.data.correlationId).toBe(outbox.correlationId);
  });

  it('revokes the expired owner so a delayed former attempt cannot publish', async () => {
    const formerAttempt = randomUUID();
    const { ref } = await createStranded({
      status: 'PROCESSING',
      attemptId: formerAttempt,
      leaseOffsetSeconds: -120,
    });

    await reconciler().reconcile();

    const recovered = await video(ref.videoId);
    expect(recovered).toMatchObject({
      status: 'PROCESSING',
      processingAttemptId: null,
    });
    const delayedCommit = await prisma.video.updateMany({
      where: {
        id: ref.videoId,
        status: 'PROCESSING',
        processingGeneration: 1,
        processingAttemptId: formerAttempt,
      },
      data: { status: 'READY', committedAttemptId: formerAttempt },
    });
    expect(delayedCommit.count).toBe(0);
    expect(await jobFor(ref)).toBeDefined();
  });

  it('gives up after bounded recoveries and records a recoverable failure', async () => {
    const { ref } = await createStranded({ recoveryAttempts: 3 });

    await reconciler().reconcile();

    await expect(video(ref.videoId)).resolves.toMatchObject({
      status: 'FAILED',
      failureReason: expect.stringContaining('could not be recovered'),
    });
    expect(await jobFor(ref)).toBeUndefined();
  });

  it('bounds each scan to the configured batch size', async () => {
    const stranded = [];
    for (let index = 0; index < 4; index += 1)
      stranded.push(await createStranded({ publishedAgoSeconds: 86_400 }));

    const summary = await new ProcessingReconciler(
      prisma as never,
      queueAdapter,
      storage,
      environment,
      { ...options, batchSize: 2 },
    ).reconcile();

    expect(summary.inspected).toBeLessThanOrEqual(2);
  });

  it('keeps published outbox evidence for unfinished generations during retention cleanup', async () => {
    const unfinished = await createStranded({});
    const finished = await createStranded({});
    await prisma.video.update({
      where: { id: finished.video.id },
      data: { status: 'FAILED' },
    });
    const ancient = new Date(Date.now() - 60 * 24 * 60 * 60 * 1_000);
    await prisma.processingOutbox.updateMany({
      where: { id: { in: [unfinished.outbox.id, finished.outbox.id] } },
      data: { publishedAt: ancient },
    });
    const publisher = new ProcessingOutboxPublisher(
      prisma as never,
      queueAdapter,
    );

    await publisher.cleanupPublished();

    expect(
      await prisma.processingOutbox.findUnique({
        where: { id: unfinished.outbox.id },
      }),
    ).not.toBeNull();
    expect(
      await prisma.processingOutbox.findUnique({
        where: { id: finished.outbox.id },
      }),
    ).toBeNull();
  });
});

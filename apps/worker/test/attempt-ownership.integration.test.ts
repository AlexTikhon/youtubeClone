import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { workerEnvironment } from '../src/config.js';
import {
  acquireAttempt,
  releaseAttempt,
  renewAttempt,
} from '../src/processing-lease.js';
import {
  AttemptBusyError,
  AttemptOwnershipLostError,
  type ProcessingError,
} from '../src/processing-error.js';
import { StorageService } from '../src/storage.service.js';
import { VideoProcessingPipeline } from '../src/video-processing.pipeline.js';

/** Real PostgreSQL and MinIO; deterministic fake FFmpeg so no media tools are needed. */
const prisma = new PrismaClient();
const storage = new StorageService();
const s3 = new S3Client({
  endpoint: workerEnvironment.S3_ENDPOINT,
  region: workerEnvironment.S3_REGION,
  forcePathStyle: workerEnvironment.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: workerEnvironment.S3_ACCESS_KEY,
    secretAccessKey: workerEnvironment.S3_SECRET_KEY,
  },
});
const suffix = randomUUID().slice(0, 8);
const original = Buffer.from('not-really-a-video');

interface Gate {
  reached: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}

function createGate(): Gate {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (markReached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    release,
    wait: async () => {
      markReached();
      await released;
    },
  };
}

function fakeMediaTools(gate?: Gate) {
  return {
    probe: async () => ({
      durationSeconds: 2,
      width: 640,
      height: 360,
      videoCodec: 'h264',
      audioCodec: null,
      container: 'mp4',
      frameRate: 30,
      bitrateKbps: 500,
      rotationDegrees: 0,
    }),
    generateThumbnail: async (_input: string, output: string) => {
      await writeFile(output, 'jpeg');
      return { width: 640, height: 360 };
    },
    generateHlsRendition: async (
      _input: string,
      directory: string,
      spec: { name: string },
    ) => {
      const renditionDirectory = join(directory, spec.name);
      await mkdir(renditionDirectory, { recursive: true });
      await writeFile(join(renditionDirectory, 'index.m3u8'), '#EXTM3U\n');
      await writeFile(join(renditionDirectory, 'segment000.ts'), 'segment');
      await gate?.wait();
      return {
        spec,
        manifestPath: join(renditionDirectory, 'index.m3u8'),
        segmentCount: 1,
      };
    },
    generateHlsMaster: async (directory: string) => {
      await writeFile(join(directory, 'master.m3u8'), '#EXTM3U\n');
      return join(directory, 'master.m3u8');
    },
  };
}

/** Pauses after objects are uploaded, before the commit fence. */
class GatedStorage extends StorageService {
  constructor(private readonly gate: Gate) {
    super();
  }

  override async uploadHls(
    ...args: Parameters<StorageService['uploadHls']>
  ): ReturnType<StorageService['uploadHls']> {
    const result = await super.uploadHls(...args);
    await this.gate.wait();
    return result;
  }
}

function createPipeline(
  gate?: Gate,
  options: ConstructorParameters<typeof VideoProcessingPipeline>[3] = {},
  uploadGate?: Gate,
) {
  return new VideoProcessingPipeline(
    prisma as never,
    uploadGate ? new GatedStorage(uploadGate) : storage,
    fakeMediaTools(gate) as never,
    { renewIntervalMs: 60_000, ...options },
  );
}

async function listKeys(bucket: string, prefix: string): Promise<string[]> {
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
  );
  return (result.Contents ?? []).flatMap((item) =>
    item.Key ? [item.Key] : [],
  );
}

async function expireLease(videoId: string): Promise<void> {
  await prisma.video.update({
    where: { id: videoId },
    data: { processingLeaseExpiresAt: new Date(Date.now() - 1_000) },
  });
}

describe('processing attempt ownership', () => {
  const created: { userIds: string[]; originalKeys: string[] } = {
    userIds: [],
    originalKeys: [],
  };

  async function createUploadedVideo() {
    const id = randomUUID().slice(0, 8);
    const user = await prisma.user.create({
      data: {
        email: `ownership-${suffix}-${id}@example.test`,
        username: `own-${suffix}-${id}`,
        passwordHash: 'integration-only',
        channel: {
          create: { handle: `own-${suffix}-${id}`, name: 'Ownership' },
        },
      },
      include: { channel: true },
    });
    created.userIds.push(user.id);
    const objectKey = `integration/ownership-${suffix}-${id}.mp4`;
    created.originalKeys.push(objectKey);
    await s3.send(
      new PutObjectCommand({
        Bucket: workerEnvironment.S3_BUCKET_ORIGINALS,
        Key: objectKey,
        Body: original,
        ContentLength: original.length,
        ContentType: 'video/mp4',
      }),
    );
    const video = await prisma.video.create({
      data: {
        channelId: user.channel!.id,
        title: 'Ownership integration',
        status: 'UPLOADED',
        processingGeneration: 1,
        assets: {
          create: {
            kind: 'ORIGINAL',
            bucket: workerEnvironment.S3_BUCKET_ORIGINALS,
            objectKey,
            mimeType: 'video/mp4',
            sizeBytes: original.length,
          },
        },
      },
      include: { assets: true },
    });
    return {
      videoId: video.id,
      job: {
        schemaVersion: 1 as const,
        videoId: video.id,
        originalAssetId: video.assets[0]!.id,
        generation: 1,
        correlationId: `ownership-${id}`,
      },
    };
  }

  async function generatedKeys(videoId: string) {
    return [
      ...(await listKeys(
        workerEnvironment.S3_BUCKET_STREAMS,
        `videos/${videoId}/`,
      )),
      ...(await listKeys(
        workerEnvironment.S3_BUCKET_THUMBNAILS,
        `videos/${videoId}/`,
      )),
    ];
  }

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
    await Promise.all(
      created.originalKeys.map((Key) =>
        s3
          .send(
            new DeleteObjectCommand({
              Bucket: workerEnvironment.S3_BUCKET_ORIGINALS,
              Key,
            }),
          )
          .catch(() => undefined),
      ),
    );
    await prisma.$disconnect();
    storage.onApplicationShutdown();
    s3.destroy();
  });

  it('lets one of two overlapping attempts win; the loser fails without removing the winner media', async () => {
    const { videoId, job } = await createUploadedVideo();
    const slowGate = createGate();
    const slow = createPipeline(undefined, { leaseSeconds: 1 }, slowGate);
    const slowResult = slow.execute('slow-job', job).then(
      () => ({ outcome: 'resolved' as const }),
      (error: unknown) => ({ outcome: 'rejected' as const, error }),
    );
    await slowGate.reached;

    // A live lease keeps a concurrent execution out entirely.
    await expect(
      createPipeline().execute('busy-job', job),
    ).rejects.toBeInstanceOf(AttemptBusyError);

    // Once the first lease expires, a second attempt takes over and wins.
    await expireLease(videoId);
    await createPipeline().execute('winner-job', job);
    const committed = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      include: { assets: true },
    });
    expect(committed.status).toBe('READY');
    const winnerAttemptId = committed.committedAttemptId!;
    expect(winnerAttemptId).toBeTruthy();
    const winnerKeys = await generatedKeys(videoId);
    expect(winnerKeys.length).toBeGreaterThan(0);
    expect(winnerKeys.every((key) => key.includes(winnerAttemptId))).toBe(true);

    // The former owner resumes and must neither publish nor delete winner output.
    slowGate.release();
    const slowOutcome = await slowResult;
    expect(slowOutcome.outcome).toBe('rejected');
    const loserError = (slowOutcome as { error: ProcessingError }).error;
    expect(loserError).toBeInstanceOf(AttemptOwnershipLostError);
    expect(loserError.attemptId).toBeTruthy();
    expect(loserError.attemptId).not.toBe(winnerAttemptId);

    const after = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      include: { assets: true },
    });
    expect(after.status).toBe('READY');
    expect(after.committedAttemptId).toBe(winnerAttemptId);
    expect(
      after.assets
        .filter((asset) => asset.kind !== 'ORIGINAL')
        .every((asset) => asset.attemptId === winnerAttemptId),
    ).toBe(true);
    expect(await generatedKeys(videoId)).toEqual(winnerKeys);
  });

  it('ignores a late fail() after READY without mutating lifecycle or deleting output', async () => {
    const { videoId, job } = await createUploadedVideo();
    const slowGate = createGate();
    const slow = createPipeline(undefined, { leaseSeconds: 1 }, slowGate);
    const slowResult = slow
      .execute('slow-job', job)
      .catch((error: unknown) => error);
    await slowGate.reached;
    await expireLease(videoId);
    await createPipeline().execute('winner-job', job);
    slowGate.release();
    const loserError = (await slowResult) as ProcessingError;
    const before = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      include: { assets: true },
    });
    const keysBefore = await generatedKeys(videoId);

    const recorded = await createPipeline().fail(
      { videoId, generation: 1, attemptId: loserError.attemptId! },
      'Late failure',
    );
    const recordedByWinner = await createPipeline().fail(
      { videoId, generation: 1, attemptId: before.committedAttemptId! },
      'Late failure from the winner',
    );

    expect(recorded).toBe(false);
    expect(recordedByWinner).toBe(false);
    const after = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      include: { assets: true },
    });
    expect(after).toEqual(before);
    expect(await generatedKeys(videoId)).toEqual(keysBefore);
  });

  it('rejects renewal and publication from a former lease owner after takeover', async () => {
    const { videoId, job } = await createUploadedVideo();
    const first = await acquireAttempt(prisma as never, {
      videoId,
      generation: 1,
      leaseSeconds: 30,
    });
    expect(first).toBeTruthy();
    // A live lease cannot be taken over.
    await expect(
      acquireAttempt(prisma as never, {
        videoId,
        generation: 1,
        leaseSeconds: 30,
      }),
    ).resolves.toBeNull();
    await expect(
      renewAttempt(
        prisma as never,
        { videoId, generation: 1, attemptId: first! },
        30,
      ),
    ).resolves.toBe(true);

    await expireLease(videoId);
    const second = await acquireAttempt(prisma as never, {
      videoId,
      generation: 1,
      leaseSeconds: 30,
    });
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    await expect(
      renewAttempt(
        prisma as never,
        { videoId, generation: 1, attemptId: first! },
        30,
      ),
    ).resolves.toBe(false);
    await expect(
      releaseAttempt(prisma as never, {
        videoId,
        generation: 1,
        attemptId: first!,
      }),
    ).resolves.toBe(false);
    await expect(
      renewAttempt(
        prisma as never,
        { videoId, generation: 1, attemptId: second! },
        30,
      ),
    ).resolves.toBe(true);

    // The pipeline cannot publish under the former owner's identity either.
    const published = await prisma.video.updateMany({
      where: {
        id: videoId,
        status: 'PROCESSING',
        processingGeneration: job.generation,
        processingAttemptId: first!,
      },
      data: { status: 'READY' },
    });
    expect(published.count).toBe(0);
  });

  it('does not publish and cleans generated output when deletion starts during processing', async () => {
    const { videoId, job } = await createUploadedVideo();
    const gate = createGate();
    const pipeline = createPipeline(gate);
    const running = pipeline.execute('delete-job', job);
    await gate.reached;
    await prisma.video.update({
      where: { id: videoId },
      data: { status: 'DELETING' },
    });
    gate.release();
    await expect(running).resolves.toBeUndefined();

    const after = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      include: { assets: true },
    });
    expect(after.status).toBe('DELETING');
    expect(after.committedAttemptId).toBeNull();
    expect(after.assets.map((asset) => asset.kind)).toEqual(['ORIGINAL']);
    expect(await generatedKeys(videoId)).toEqual([]);
  });

  it('removes only the losing attempt output and leaves a newer owner untouched', async () => {
    const { videoId, job } = await createUploadedVideo();
    const uploadGate = createGate();
    const slow = createPipeline(undefined, { leaseSeconds: 1 }, uploadGate);
    const slowResult = slow
      .execute('slow-job', job)
      .catch((error: unknown) => error);
    await uploadGate.reached;
    const loserKeys = await generatedKeys(videoId);
    expect(loserKeys.length).toBeGreaterThan(0);

    await expireLease(videoId);
    const newOwner = await acquireAttempt(prisma as never, {
      videoId,
      generation: 1,
      leaseSeconds: 60,
    });
    expect(newOwner).toBeTruthy();
    const newOwnerKey = `videos/${videoId}/generations/1/attempts/${newOwner}/hls/master.m3u8`;
    await s3.send(
      new PutObjectCommand({
        Bucket: workerEnvironment.S3_BUCKET_STREAMS,
        Key: newOwnerKey,
        Body: '#EXTM3U\n',
      }),
    );

    uploadGate.release();
    expect(await slowResult).toBeInstanceOf(AttemptOwnershipLostError);
    expect(await generatedKeys(videoId)).toEqual([newOwnerKey]);
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ).resolves.toMatchObject({
      status: 'PROCESSING',
      processingAttemptId: newOwner,
      committedAttemptId: null,
    });
  });

  it('fences the READY commit itself against a takeover after the last ownership check', async () => {
    const { videoId, job } = await createUploadedVideo();
    let newOwner: string | null = null;
    // Takes the generation over at the exact moment the commit begins.
    const racing = new Proxy(prisma, {
      get(target, property) {
        if (property === '$transaction') {
          return async (callback: never) => {
            await expireLease(videoId);
            newOwner = await acquireAttempt(prisma as never, {
              videoId,
              generation: 1,
              leaseSeconds: 60,
            });
            return target.$transaction(callback);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const pipeline = new VideoProcessingPipeline(
      racing as never,
      storage,
      fakeMediaTools() as never,
      { renewIntervalMs: 60_000 },
    );

    await expect(pipeline.execute('race-job', job)).rejects.toBeInstanceOf(
      AttemptOwnershipLostError,
    );

    const after = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      include: { assets: true },
    });
    expect(after).toMatchObject({
      status: 'PROCESSING',
      processingAttemptId: newOwner,
      committedAttemptId: null,
    });
    expect(after.assets.map((asset) => asset.kind)).toEqual(['ORIGINAL']);
    expect(await generatedKeys(videoId)).toEqual([]);
  });

  it('fails a stranded generation only when no live lease exists, and removes the dead attempt output', async () => {
    const { videoId } = await createUploadedVideo();
    const attemptId = await acquireAttempt(prisma as never, {
      videoId,
      generation: 1,
      leaseSeconds: 60,
    });
    const deadKey = `videos/${videoId}/generations/1/attempts/${attemptId}/hls/master.m3u8`;
    await s3.send(
      new PutObjectCommand({
        Bucket: workerEnvironment.S3_BUCKET_STREAMS,
        Key: deadKey,
        Body: '#EXTM3U\n',
      }),
    );
    const pipeline = createPipeline();

    // A live lease is a legitimate worker; BullMQ's verdict cannot override it.
    await expect(
      pipeline.failStranded(videoId, 1, 'Stopped unexpectedly'),
    ).resolves.toBe(false);
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ).resolves.toMatchObject({ status: 'PROCESSING' });
    expect(await generatedKeys(videoId)).toEqual([deadKey]);

    await expireLease(videoId);
    await expect(
      pipeline.failStranded(videoId, 1, 'Stopped unexpectedly'),
    ).resolves.toBe(true);
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      failureReason: 'Stopped unexpectedly',
      processingAttemptId: null,
    });
    expect(await generatedKeys(videoId)).toEqual([]);
    // The former owner can no longer renew or publish.
    await expect(
      renewAttempt(
        prisma as never,
        { videoId, generation: 1, attemptId: attemptId! },
        60,
      ),
    ).resolves.toBe(false);
  });

  it('records a failure only for the current lease owner', async () => {
    const { videoId } = await createUploadedVideo();
    const attemptId = await acquireAttempt(prisma as never, {
      videoId,
      generation: 1,
      leaseSeconds: 60,
    });
    const pipeline = createPipeline();

    await expect(
      pipeline.fail(
        { videoId, generation: 1, attemptId: randomUUID() },
        'Not the owner',
      ),
    ).resolves.toBe(false);
    await expect(
      pipeline.fail({ videoId, generation: 2, attemptId: attemptId! }, 'Stale'),
    ).resolves.toBe(false);
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ).resolves.toMatchObject({ status: 'PROCESSING' });

    await expect(
      pipeline.fail(
        { videoId, generation: 1, attemptId: attemptId! },
        'Owner failure',
      ),
    ).resolves.toBe(true);
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: videoId } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      failureReason: 'Owner failure',
      processingAttemptId: null,
      processingLeaseExpiresAt: null,
    });
  });
});

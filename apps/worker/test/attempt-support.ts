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

import { workerEnvironment } from '../src/config.js';
import { StorageService } from '../src/storage.service.js';
import { VideoProcessingPipeline } from '../src/video-processing.pipeline.js';

/** Shared real-PostgreSQL / real-MinIO fixtures for attempt-lifetime tests. */
export const prisma = new PrismaClient();
export const storage = new StorageService();
export const s3 = new S3Client({
  endpoint: workerEnvironment.S3_ENDPOINT,
  region: workerEnvironment.S3_REGION,
  forcePathStyle: workerEnvironment.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: workerEnvironment.S3_ACCESS_KEY,
    secretAccessKey: workerEnvironment.S3_SECRET_KEY,
  },
});
export const suffix = randomUUID().slice(0, 8);
const original = Buffer.from('not-really-a-video');

export const metadata = {
  durationSeconds: 2,
  width: 640,
  height: 360,
  videoCodec: 'h264',
  audioCodec: null,
  container: 'mp4',
  frameRate: 30,
  bitrateKbps: 500,
  rotationDegrees: 0,
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic stand-in for FFmpeg. `blockRendition` models a long-running
 * subprocess: it settles only when the attempt's signal aborts, exactly like a
 * killed child process would.
 */
export function fakeMediaTools(
  options: {
    blockRendition?: (signal: AbortSignal | undefined) => Promise<void>;
  } = {},
) {
  return {
    probe: async () => metadata,
    generateThumbnail: async (_input: string, output: string) => {
      await writeFile(output, 'jpeg');
      return { width: 640, height: 360 };
    },
    generateHlsRendition: async (
      _input: string,
      directory: string,
      spec: { name: string },
      signal?: AbortSignal,
    ) => {
      const renditionDirectory = join(directory, spec.name);
      await mkdir(renditionDirectory, { recursive: true });
      await writeFile(join(renditionDirectory, 'index.m3u8'), '#EXTM3U\n');
      await writeFile(join(renditionDirectory, 'segment000.ts'), 'segment');
      await options.blockRendition?.(signal);
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

/** Resolves when `signal` aborts, rejecting with its reason like real I/O does. */
export function blockUntilAborted(
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (!signal) return; // never settles: the test would time out, by design
    const fail = () => reject(signal.reason);
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

export function createPipeline(
  options: ConstructorParameters<typeof VideoProcessingPipeline>[3] = {},
  mediaTools: object = fakeMediaTools(),
  storageService: StorageService = storage,
  database: PrismaClient = prisma,
) {
  return new VideoProcessingPipeline(
    database as never,
    storageService,
    mediaTools as never,
    { renewIntervalMs: 60_000, ...options },
  );
}

export async function listKeys(
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
  );
  return (result.Contents ?? []).flatMap((item) =>
    item.Key ? [item.Key] : [],
  );
}

export async function generatedKeys(videoId: string): Promise<string[]> {
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

export async function expireLease(videoId: string): Promise<void> {
  await prisma.video.update({
    where: { id: videoId },
    data: { processingLeaseExpiresAt: new Date(Date.now() - 1_000) },
  });
}

export const created: { userIds: string[]; originalKeys: string[] } = {
  userIds: [],
  originalKeys: [],
};

export async function createUploadedVideo() {
  const id = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      email: `lifetime-${suffix}-${id}@example.test`,
      username: `life-${suffix}-${id}`,
      passwordHash: 'integration-only',
      channel: {
        create: { handle: `life-${suffix}-${id}`, name: 'Lifetime' },
      },
    },
    include: { channel: true },
  });
  created.userIds.push(user.id);
  const objectKey = `integration/lifetime-${suffix}-${id}.mp4`;
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
      title: 'Lifetime integration',
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
    objectKey,
    job: {
      schemaVersion: 1 as const,
      videoId: video.id,
      originalAssetId: video.assets[0]!.id,
      generation: 1,
      correlationId: `lifetime-${id}`,
    },
  };
}

export async function cleanupFixtures(): Promise<void> {
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
}

import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { MediaToolsService } from '../src/media-tools.service.js';
import { StorageService } from '../src/storage.service.js';
import { VideoProcessingPipeline } from '../src/video-processing.pipeline.js';
import { workerEnvironment } from '../src/config.js';

describe('real failed-processing recovery', () => {
  it('processes generation two to READY with only generation-two authoritative assets', async () => {
    const prisma = new PrismaClient();
    const storage = new StorageService();
    const mediaTools = new MediaToolsService();
    const pipeline = new VideoProcessingPipeline(
      prisma as never,
      storage,
      mediaTools,
    );
    const s3 = new S3Client({
      endpoint: workerEnvironment.S3_ENDPOINT,
      region: workerEnvironment.S3_REGION,
      forcePathStyle: workerEnvironment.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: workerEnvironment.S3_ACCESS_KEY,
        secretAccessKey: workerEnvironment.S3_SECRET_KEY,
      },
    });
    const directory = await mkdtemp(join(tmpdir(), 'youtube-clone-retry-'));
    const originalPath = join(directory, 'source.mp4');
    const suffix = randomUUID().slice(0, 8);
    const objectKey = `integration/retry-ready-${suffix}.mp4`;
    let userId = '';
    let videoId = '';
    try {
      await generateFixture(originalPath);
      const originalStat = await stat(originalPath);
      await s3.send(
        new PutObjectCommand({
          Bucket: workerEnvironment.S3_BUCKET_ORIGINALS,
          Key: objectKey,
          Body: createReadStream(originalPath),
          ContentLength: originalStat.size,
          ContentType: 'video/mp4',
        }),
      );
      const user = await prisma.user.create({
        data: {
          email: `media-retry-${suffix}@example.test`,
          username: `media-retry-${suffix}`,
          passwordHash: 'integration-only',
          channel: {
            create: {
              handle: `media-retry-${suffix}`,
              name: 'Media Retry',
            },
          },
        },
        include: { channel: true },
      });
      userId = user.id;
      const video = await prisma.video.create({
        data: {
          channelId: user.channel!.id,
          title: 'Retry to ready',
          status: 'FAILED',
          processingGeneration: 1,
          failureReason: 'Previous generation failed',
          assets: {
            create: {
              kind: 'ORIGINAL',
              bucket: workerEnvironment.S3_BUCKET_ORIGINALS,
              objectKey,
              mimeType: 'video/mp4',
              sizeBytes: originalStat.size,
            },
          },
        },
        include: { assets: true },
      });
      videoId = video.id;
      const original = video.assets[0]!;

      await prisma.$transaction(async (transaction) => {
        const claimed = await transaction.video.updateMany({
          where: {
            id: video.id,
            status: 'FAILED',
            processingGeneration: 1,
          },
          data: {
            status: 'PROCESSING',
            processingGeneration: 2,
            failureReason: null,
          },
        });
        expect(claimed.count).toBe(1);
        await transaction.processingOutbox.create({
          data: {
            videoId: video.id,
            generation: 2,
            originalAssetId: original.id,
            correlationId: `media-retry-${suffix}`,
          },
        });
      });

      await pipeline.execute('media-retry-job', {
        schemaVersion: 1,
        videoId: video.id,
        originalAssetId: original.id,
        generation: 2,
        correlationId: `media-retry-${suffix}`,
      });

      const completed = await prisma.video.findUniqueOrThrow({
        where: { id: video.id },
        include: { assets: true },
      });
      expect(completed).toMatchObject({
        status: 'READY',
        processingGeneration: 2,
        failureReason: null,
      });
      const generated = completed.assets.filter(
        (asset) => asset.kind !== 'ORIGINAL',
      );
      expect(generated.map((asset) => asset.kind).sort()).toEqual([
        'HLS_MANIFEST',
        'THUMBNAIL',
      ]);
      expect(
        generated.every((asset) => asset.objectKey.includes(`/generations/2/`)),
      ).toBe(true);
    } finally {
      if (videoId) await storage.removeGenerated(videoId, 2);
      if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      await s3
        .send(
          new DeleteObjectCommand({
            Bucket: workerEnvironment.S3_BUCKET_ORIGINALS,
            Key: objectKey,
          }),
        )
        .catch(() => undefined);
      await prisma.$disconnect();
      storage.onApplicationShutdown();
      s3.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

function generateFixture(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      workerEnvironment.FFMPEG_PATH,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=30:duration=2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-an',
        outputPath,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-100_000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${String(code)}: ${stderr}`));
    });
  });
}

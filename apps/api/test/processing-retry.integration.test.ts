import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VIDEO_PROCESSING_QUEUE_NAME } from '@youtube-clone/types';

import { AppModule } from '../src/app.module.js';
import { hashPassword } from '../src/auth/password.js';
import { ApiExceptionFilter } from '../src/infrastructure/http/api-exception.filter.js';
import { processingJobId } from '../src/infrastructure/queue/video-processing-queue.port.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';

describe.skipIf(!enabled)('processing retry integration', () => {
  const prisma = new PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const bucket = process.env.S3_BUCKET_ORIGINALS ?? 'video-originals';
  const objectKey = `integration/retry-${suffix}.mp4`;
  const originalBody = Buffer.from('video-bytes');
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  });
  const queue = new Queue(VIDEO_PROCESSING_QUEUE_NAME, {
    connection: { url: process.env.REDIS_URL },
  });
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl = '';
  let userId = '';
  let videoId = '';
  let cookie = '';

  beforeAll(async () => {
    const passwordHash = await hashPassword('integration-password');
    const user = await prisma.user.create({
      data: {
        email: `retry-${suffix}@example.test`,
        username: `retry-${suffix}`,
        passwordHash,
        channel: {
          create: { handle: `retry-${suffix}`, name: 'Retry Creator' },
        },
      },
      include: { channel: true },
    });
    userId = user.id;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: originalBody,
        ContentLength: originalBody.length,
        ContentType: 'video/mp4',
      }),
    );
    const video = await prisma.video.create({
      data: {
        channelId: user.channel!.id,
        title: 'Failed processing integration video',
        status: 'FAILED',
        processingGeneration: 1,
        failureReason: 'The video could not be transcoded',
        assets: {
          create: {
            kind: 'ORIGINAL',
            bucket,
            objectKey,
            mimeType: 'video/mp4',
            sizeBytes: originalBody.length,
          },
        },
      },
    });
    videoId = video.id;

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `retry-${suffix}@example.test`,
        password: 'integration-password',
      }),
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  }, 30_000);

  afterAll(async () => {
    if (videoId)
      await queue.remove(processingJobId({ videoId, generation: 2 }));
    await app?.close();
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await s3
      .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
      .catch(() => undefined);
    await Promise.all([queue.close(), prisma.$disconnect()]);
    s3.destroy();
  });

  it('accepts exactly one concurrent retry and durably publishes generation two', async () => {
    const retry = () =>
      fetch(`${baseUrl}/api/v1/videos/${videoId}/retry-processing`, {
        method: 'POST',
        headers: { cookie },
      });
    const responses = await Promise.all([retry(), retry()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);

    await expect(
      prisma.video.findUniqueOrThrow({
        where: { id: videoId },
        select: { status: true, processingGeneration: true },
      }),
    ).resolves.toEqual({ status: 'PROCESSING', processingGeneration: 2 });
    expect(
      await prisma.processingOutbox.count({
        where: { videoId, generation: 2 },
      }),
    ).toBe(1);

    const deadline = Date.now() + 5_000;
    let job = await queue.getJob(processingJobId({ videoId, generation: 2 }));
    while (!job && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = await queue.getJob(processingJobId({ videoId, generation: 2 }));
    }
    expect(job?.data).toMatchObject({ videoId, generation: 2 });
  });
});

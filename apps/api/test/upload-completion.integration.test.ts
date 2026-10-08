import { randomUUID } from 'node:crypto';

import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiEnvironmentSchema, parseEnvironment } from '@youtube-clone/config';

import { S3StorageAdapter } from '../src/infrastructure/storage/s3-storage.adapter.js';
import { UploadsService } from '../src/uploads/uploads.service.js';
import { VideosService } from '../src/videos/videos.service.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';

describe.skipIf(!enabled)('idempotent upload completion', () => {
  const environment = parseEnvironment(apiEnvironmentSchema, process.env);
  const prisma = new PrismaClient();
  const adapter = new S3StorageAdapter(environment);
  const videos = new VideosService(prisma as never, adapter, environment);
  const uploads = new UploadsService(
    prisma as never,
    videos,
    adapter,
    environment,
  );
  const s3 = new S3Client({
    endpoint: environment.S3_ENDPOINT,
    region: environment.S3_REGION,
    forcePathStyle: environment.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: environment.S3_ACCESS_KEY,
      secretAccessKey: environment.S3_SECRET_KEY,
    },
  });
  const suffix = randomUUID().slice(0, 8);
  const keys: string[] = [];
  const userIds: string[] = [];
  let ownerId = '';
  let channelId = '';
  let strangerId = '';
  const bytes = new Uint8Array(512);

  async function postBytes(intent: {
    uploadUrl: string;
    fields: Record<string, string>;
  }) {
    const form = new FormData();
    for (const [name, value] of Object.entries(intent.fields))
      form.append(name, value);
    form.append('file', new Blob([bytes as BlobPart]), 'clip.mp4');
    const response = await fetch(intent.uploadUrl, {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(204);
  }

  async function createUploadedDraft(upload = true) {
    const video = await prisma.video.create({
      data: { channelId, title: `Completion ${suffix}` },
    });
    const intent = await uploads.start(video.id, ownerId, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: bytes.length,
    });
    keys.push(intent.fields.key!);
    if (upload) await postBytes(intent);
    return { video, intent };
  }

  async function counts(videoId: string) {
    const [assets, outbox] = await Promise.all([
      prisma.videoAsset.count({ where: { videoId, kind: 'ORIGINAL' } }),
      prisma.processingOutbox.count({ where: { videoId } }),
    ]);
    return { assets, outbox };
  }

  beforeAll(async () => {
    for (const name of ['owner', 'stranger']) {
      const user = await prisma.user.create({
        data: {
          email: `completion-${name}-${suffix}@example.test`,
          username: `cmp-${name}-${suffix}`,
          passwordHash: 'integration-only',
          channel: {
            create: { handle: `cmp-${name}-${suffix}`, name: 'Completion' },
          },
        },
        include: { channel: true },
      });
      userIds.push(user.id);
      if (name === 'owner') {
        ownerId = user.id;
        channelId = user.channel!.id;
      } else strangerId = user.id;
    }
  });

  afterAll(async () => {
    await Promise.all(
      keys.map((Key) =>
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
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
    adapter.onApplicationShutdown();
    s3.destroy();
  });

  it('creates one original asset and one outbox event under concurrent completion', async () => {
    const { video } = await createUploadedDraft();

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        uploads.complete(video.id, ownerId, `concurrent-${index}`),
      ),
    );

    expect(results.every((result) => result.status === 'UPLOADED')).toBe(true);
    expect(results.filter((result) => !result.alreadyCompleted)).toHaveLength(
      1,
    );
    expect(await counts(video.id)).toEqual({ assets: 1, outbox: 1 });
    await expect(
      prisma.video.findUniqueOrThrow({ where: { id: video.id } }),
    ).resolves.toMatchObject({ status: 'UPLOADED', processingGeneration: 1 });
  });

  it.each(['PROCESSING', 'READY', 'FAILED'] as const)(
    'recovers a lost completion response once the worker moved the video to %s, without another upload',
    async (status) => {
      const { video } = await createUploadedDraft();
      await uploads.complete(video.id, ownerId, 'first-response-lost');
      await prisma.video.update({ where: { id: video.id }, data: { status } });
      const before = await counts(video.id);

      const retry = await uploads.complete(video.id, ownerId, 'retry');

      expect(retry).toEqual({
        videoId: video.id,
        status,
        processingGeneration: 1,
        alreadyCompleted: true,
      });
      expect(await counts(video.id)).toEqual(before);
    },
  );

  it('still lets a genuinely failed upload be uploaded again', async () => {
    const { video, intent } = await createUploadedDraft(false);

    await expect(
      uploads.complete(video.id, ownerId, 'too-early'),
    ).rejects.toMatchObject({ code: 'UPLOADED_OBJECT_NOT_FOUND', status: 409 });
    expect(await counts(video.id)).toEqual({ assets: 0, outbox: 0 });

    const again = await uploads.start(video.id, ownerId, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: bytes.length,
    });
    expect(again.fields.key).toBe(intent.fields.key);
    await postBytes(again);
    await expect(
      uploads.complete(video.id, ownerId, 'after-reupload'),
    ).resolves.toMatchObject({ status: 'UPLOADED', alreadyCompleted: false });
  });

  it('keeps authorization and deletion barriers intact', async () => {
    const { video } = await createUploadedDraft();
    await uploads.complete(video.id, ownerId, 'accepted');

    await expect(
      uploads.complete(video.id, strangerId, 'intruder'),
    ).rejects.toMatchObject({ code: 'VIDEO_NOT_FOUND', status: 404 });

    await prisma.video.update({
      where: { id: video.id },
      data: { status: 'DELETING' },
    });
    await expect(
      uploads.complete(video.id, ownerId, 'deleting'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not treat an unrelated pending upload as accepted', async () => {
    const { video } = await createUploadedDraft(false);
    await prisma.video.update({
      where: { id: video.id },
      data: { status: 'FAILED' },
    });

    await expect(
      uploads.complete(video.id, ownerId, 'unrelated'),
    ).rejects.toMatchObject({ code: 'VIDEO_STATE_CONFLICT', status: 409 });
  });
});

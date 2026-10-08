import { randomUUID } from 'node:crypto';

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiEnvironmentSchema, parseEnvironment } from '@youtube-clone/config';

import { S3StorageAdapter } from '../src/infrastructure/storage/s3-storage.adapter.js';
import { UploadsService } from '../src/uploads/uploads.service.js';
import { VideosService } from '../src/videos/videos.service.js';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';

interface Intent {
  uploadUrl: string;
  fields: Record<string, string>;
  sizeBytes: number;
}

/** Posts the way a browser form upload does: fields first, the file last. */
async function postToStorage(
  intent: Pick<Intent, 'uploadUrl' | 'fields'>,
  body: Uint8Array,
  overrides: Record<string, string> = {},
) {
  const form = new FormData();
  for (const [name, value] of Object.entries({
    ...intent.fields,
    ...overrides,
  }))
    form.append(name, value);
  form.append('file', new Blob([body as BlobPart]), 'clip.mp4');
  const response = await fetch(intent.uploadUrl, {
    method: 'POST',
    body: form,
  });
  return { status: response.status, body: await response.text() };
}

describe.skipIf(!enabled)('upload admission at object storage', () => {
  const environment = parseEnvironment(apiEnvironmentSchema, {
    ...process.env,
    MAX_UPLOAD_SIZE_BYTES: '10000',
  });
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
  let userId = '';
  let channelId = '';

  async function startUpload(sizeBytes: number) {
    const video = await prisma.video.create({
      data: { channelId, title: `Admission ${suffix}` },
    });
    const intent = (await uploads.start(video.id, userId, {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes,
    })) as unknown as Intent;
    keys.push(intent.fields.key!);
    return { video, intent };
  }

  async function objectSize(key: string): Promise<number | null> {
    try {
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: environment.S3_BUCKET_ORIGINALS,
          Key: key,
        }),
      );
      return head.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `admission-${suffix}@example.test`,
        username: `admission-${suffix}`,
        passwordHash: 'integration-only',
        channel: {
          create: { handle: `admission-${suffix}`, name: 'Admission' },
        },
      },
      include: { channel: true },
    });
    userId = user.id;
    channelId = user.channel!.id;
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
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
    adapter.onApplicationShutdown();
    s3.destroy();
  });

  it('accepts exactly the declared number of bytes and then completes', async () => {
    const { video, intent } = await startUpload(1_000);

    const result = await postToStorage(intent, new Uint8Array(1_000));

    expect(result.status).toBe(204);
    expect(await objectSize(intent.fields.key!)).toBe(1_000);
    await expect(
      uploads.complete(video.id, userId, 'admission-test'),
    ).resolves.toMatchObject({ videoId: video.id, status: 'UPLOADED' });
  });

  it('rejects more bytes than declared even though the declared size is allowed', async () => {
    const { intent } = await startUpload(1_000);

    const result = await postToStorage(intent, new Uint8Array(5_000));

    expect(result.status).toBe(400);
    expect(result.body).toContain('EntityTooLarge');
    expect(await objectSize(intent.fields.key!)).toBeNull();
  });

  it('rejects one byte over the declared size', async () => {
    const { intent } = await startUpload(1_000);

    const result = await postToStorage(intent, new Uint8Array(1_001));

    expect(result.status).toBe(400);
    expect(await objectSize(intent.fields.key!)).toBeNull();
  });

  it('rejects fewer bytes than declared', async () => {
    const { intent } = await startUpload(1_000);

    const result = await postToStorage(intent, new Uint8Array(999));

    expect(result.status).toBe(400);
    expect(result.body).toContain('EntityTooSmall');
    expect(await objectSize(intent.fields.key!)).toBeNull();
  });

  it('rejects a different object key', async () => {
    const { intent } = await startUpload(1_000);
    const foreignKey = `originals/${randomUUID()}/foreign.mp4`;
    keys.push(foreignKey);

    const result = await postToStorage(intent, new Uint8Array(1_000), {
      key: foreignKey,
    });

    expect(result.status).toBe(403);
    expect(await objectSize(foreignKey)).toBeNull();
    expect(await objectSize(intent.fields.key!)).toBeNull();
  });

  it('rejects a different content type', async () => {
    const { intent } = await startUpload(1_000);

    const result = await postToStorage(intent, new Uint8Array(1_000), {
      'Content-Type': 'text/html',
    });

    expect(result.status).toBe(403);
    expect(await objectSize(intent.fields.key!)).toBeNull();
  });

  it('rejects an upload after the credentials expire', async () => {
    const key = `originals/${randomUUID()}/expired.mp4`;
    keys.push(key);
    const policy = await adapter.createUploadPolicy({
      bucket: environment.S3_BUCKET_ORIGINALS,
      objectKey: key,
      contentType: 'video/mp4',
      sizeBytes: 100n,
      expiresInSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const result = await postToStorage(
      { uploadUrl: policy.url, fields: policy.fields },
      new Uint8Array(100),
    );

    expect(result.status).toBe(403);
    expect(await objectSize(key)).toBeNull();
  });

  it('keeps private bucket reads unauthenticated-denied', async () => {
    const { intent } = await startUpload(1_000);
    await postToStorage(intent, new Uint8Array(1_000));

    const anonymous = await fetch(
      `${environment.S3_ENDPOINT}/${environment.S3_BUCKET_ORIGINALS}/${intent.fields.key!}`,
    );

    expect(anonymous.status).toBe(403);
  });
});

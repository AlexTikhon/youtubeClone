import { describe, expect, it, vi } from 'vitest';

import { S3StorageAdapter } from './s3-storage.adapter.js';
import {
  ObjectNotFoundError,
  ObjectStorageUnavailableError,
} from './storage.port.js';

function createAdapter() {
  const adapter = new S3StorageAdapter({
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: true,
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test',
  } as never);
  const client = { send: vi.fn(), destroy: vi.fn() };
  (adapter as unknown as { client: typeof client }).client = client;
  return { adapter, client };
}

describe('S3StorageAdapter error boundary', () => {
  it('classifies an S3 missing-object response', async () => {
    const { adapter, client } = createAdapter();
    client.send.mockRejectedValueOnce(
      Object.assign(new Error('internal key detail'), { name: 'NotFound' }),
    );

    await expect(
      adapter.headObject('bucket', 'private/key'),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('classifies connection and service failures as unavailable', async () => {
    const { adapter, client } = createAdapter();
    client.send.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(
      adapter.getObject('bucket', 'private/key'),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
  });

  it('rejects a successful DeleteObjects response with per-key errors', async () => {
    const { adapter, client } = createAdapter();
    const logger = { error: vi.fn() };
    (adapter as unknown as { logger: typeof logger }).logger = logger;
    client.send
      .mockResolvedValueOnce({ Contents: [{ Key: 'private/key' }] })
      .mockResolvedValueOnce({
        Errors: [
          { Key: 'private/key', Code: 'AccessDenied', Message: 'denied' },
        ],
      });

    await expect(
      adapter.deletePrefix('bucket', 'private/'),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    expect(logger.error).toHaveBeenCalledWith({
      event: 'storage.delete_prefix.partial_failure',
      failureCount: 1,
      errorCodes: ['AccessDenied'],
    });
  });
});

describe('S3StorageAdapter upload admission policy', () => {
  function decodePolicy(fields: Record<string, string>) {
    return JSON.parse(
      Buffer.from(fields.Policy!, 'base64').toString('utf8'),
    ) as { expiration: string; conditions: unknown[] };
  }

  it('binds the upload to its exact key, content type, size and lifetime', async () => {
    const adapter = new S3StorageAdapter({
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: true,
      S3_ACCESS_KEY: 'test',
      S3_SECRET_KEY: 'test',
    } as never);
    const before = Date.now();

    const policy = await adapter.createUploadPolicy({
      bucket: 'video-originals',
      objectKey: 'originals/video/file.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1234n,
      expiresInSeconds: 900,
    });

    expect(policy.url).toBe('http://localhost:9000/video-originals');
    expect(policy.fields).toMatchObject({
      key: 'originals/video/file.mp4',
      'Content-Type': 'video/mp4',
    });
    const { conditions, expiration } = decodePolicy(policy.fields);
    expect(conditions).toEqual(
      expect.arrayContaining([
        { bucket: 'video-originals' },
        { key: 'originals/video/file.mp4' },
        { 'Content-Type': 'video/mp4' },
        ['content-length-range', 1234, 1234],
      ]),
    );
    const lifetimeMs = Date.parse(expiration) - before;
    expect(lifetimeMs).toBeGreaterThan(890_000);
    expect(lifetimeMs).toBeLessThanOrEqual(901_000);
    adapter.onApplicationShutdown();
  });

  it('classifies a signing failure as storage unavailable', async () => {
    const adapter = new S3StorageAdapter({
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: true,
      S3_ACCESS_KEY: 'test',
      S3_SECRET_KEY: 'test',
    } as never);

    await expect(
      adapter.createUploadPolicy({
        bucket: 'video-originals',
        objectKey: 'k',
        contentType: 'video/mp4',
        sizeBytes: -1n,
        expiresInSeconds: 900,
      }),
    ).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
    adapter.onApplicationShutdown();
  });
});

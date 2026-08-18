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

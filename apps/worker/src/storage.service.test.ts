import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { ProcessingError } from './processing-error.js';
import { StorageService } from './storage.service.js';

describe('StorageService original verification', () => {
  it('rejects an object whose size changed after API completion', async () => {
    const service = new StorageService();
    const body = Readable.from('changed');
    const client = {
      send: vi.fn().mockResolvedValue({
        Body: body,
        ContentLength: 7,
      }),
      destroy: vi.fn(),
    };
    (service as unknown as { client: typeof client }).client = client;

    const result = service.download(
      'originals',
      'originals/video/file.mp4',
      'unused-destination',
      8n,
    );
    await expect(result).rejects.toMatchObject<Partial<ProcessingError>>({
      retryable: false,
      publicReason: 'The uploaded video changed before processing',
    });
    expect(body.destroyed).toBe(true);
    service.onApplicationShutdown();
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});

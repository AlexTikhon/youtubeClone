import { Readable } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('StorageService ABR upload', () => {
  it('uploads every variant before the master manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'youtube-clone-storage-'));
    const service = new StorageService();
    const uploadFile = vi.fn().mockResolvedValue(10n);
    (
      service as unknown as {
        uploadFile: typeof uploadFile;
      }
    ).uploadFile = uploadFile;
    try {
      await writeFile(join(directory, 'master.m3u8'), '#EXTM3U\n');
      for (const name of ['360p', '480p']) {
        const renditionDirectory = join(directory, name);
        await mkdir(renditionDirectory);
        await writeFile(join(renditionDirectory, 'index.m3u8'), '#EXTM3U\n');
        await writeFile(join(renditionDirectory, 'segment000.ts'), 'segment');
      }

      const result = await service.uploadHls('video-id', directory, [
        '360p',
        '480p',
      ]);

      expect(result.masterManifestKey).toBe('videos/video-id/hls/master.m3u8');
      expect(result.renditions).toEqual([
        expect.objectContaining({
          name: '360p',
          manifestKey: 'videos/video-id/hls/360p/index.m3u8',
          segmentCount: 1,
        }),
        expect.objectContaining({
          name: '480p',
          manifestKey: 'videos/video-id/hls/480p/index.m3u8',
          segmentCount: 1,
        }),
      ]);
      expect(uploadFile.mock.calls.at(-1)?.[1]).toBe(
        'videos/video-id/hls/master.m3u8',
      );
    } finally {
      service.onApplicationShutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

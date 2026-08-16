import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { MediaController } from './media.controller.js';

function createHttpDoubles(visibility: 'PUBLIC' | 'PRIVATE' = 'PUBLIC') {
  const videos = {
    assertMediaAccess: vi.fn().mockResolvedValue({ visibility }),
  };
  const storage = {
    getObject: vi.fn().mockResolvedValue({
      body: Readable.from('#EXTM3U\n'),
      contentType: 'application/vnd.apple.mpegurl',
      sizeBytes: 8,
    }),
  };
  const request = Object.assign(new EventEmitter(), { user: undefined });
  const response = Object.assign(new PassThrough(), {
    setHeader: vi.fn(),
  });
  const controller = new MediaController(
    videos as never,
    storage as never,
    { S3_BUCKET_STREAMS: 'streams' } as never,
  );
  return { controller, request, response, storage };
}

describe('MediaController ABR routes', () => {
  it('serves the master manifest from the current video prefix', async () => {
    const { controller, request, response, storage } = createHttpDoubles();

    await controller.masterManifest(
      '11111111-1111-4111-8111-111111111111',
      request as never,
      response as never,
    );

    expect(storage.getObject).toHaveBeenCalledWith(
      'streams',
      'videos/11111111-1111-4111-8111-111111111111/hls/master.m3u8',
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'cache-control',
      'public, max-age=31536000, immutable',
    );
  });

  it('serves only allow-listed nested variant resources', async () => {
    const { controller, request, response, storage } = createHttpDoubles();

    await controller.hls(
      '11111111-1111-4111-8111-111111111111',
      '480p',
      'segment000.ts',
      request as never,
      response as never,
    );

    expect(storage.getObject).toHaveBeenCalledWith(
      'streams',
      'videos/11111111-1111-4111-8111-111111111111/hls/480p/segment000.ts',
    );
  });

  it.each([
    ['..', 'index.m3u8'],
    ['%2e%2e', 'index.m3u8'],
    ['360p', '../master.m3u8'],
    ['1080p', 'index.m3u8'],
    ['720p', 'https://example.test/file.ts'],
  ])('rejects traversal or non-ladder path %s/%s', (rendition, fileName) => {
    const { controller, request, response, storage } = createHttpDoubles();
    expect(() =>
      controller.hls(
        '11111111-1111-4111-8111-111111111111',
        rendition,
        fileName,
        request as never,
        response as never,
      ),
    ).toThrow('Media was not found');
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('never publicly caches private manifests', async () => {
    const { controller, request, response } = createHttpDoubles('PRIVATE');
    await controller.masterManifest(
      '11111111-1111-4111-8111-111111111111',
      request as never,
      response as never,
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      'cache-control',
      'private, no-store',
    );
  });
});

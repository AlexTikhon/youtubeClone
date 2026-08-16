import { describe, expect, it, vi } from 'vitest';
import { VideoProcessingPipeline } from './video-processing.pipeline.js';

describe('VideoProcessingPipeline deletion barrier', () => {
  it('does not touch storage when deletion already owns the video', async () => {
    const database = {
      video: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'video-id',
          status: 'DELETING',
          processingGeneration: 1,
          assets: [],
        }),
      },
    };
    const storage = { download: vi.fn() };
    const pipeline = new VideoProcessingPipeline(
      database as never,
      storage as never,
      {} as never,
    );
    await pipeline.execute('job-id', {
      schemaVersion: 1,
      videoId: 'video-id',
      originalAssetId: 'asset-id',
      generation: 1,
      correlationId: 'request-id',
    });
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('removes the entire generated ABR prefix when deletion wins at commit', async () => {
    const transaction = {
      videoAsset: { update: vi.fn(), upsert: vi.fn() },
      video: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const database = {
      video: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            id: 'video-id',
            status: 'UPLOADED',
            processingGeneration: 1,
            assets: [
              {
                id: 'asset-id',
                bucket: 'originals',
                objectKey: 'original.mp4',
                sizeBytes: 100n,
              },
            ],
          })
          .mockResolvedValueOnce({
            status: 'DELETING',
            processingGeneration: 1,
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(1),
      },
      $transaction: vi.fn(
        async (callback: (input: typeof transaction) => Promise<void>) =>
          callback(transaction),
      ),
    };
    const storage = {
      download: vi.fn(),
      removeGenerated: vi.fn().mockResolvedValue(undefined),
      uploadThumbnail: vi.fn().mockResolvedValue({
        bucket: 'thumbnails',
        objectKey: 'videos/video-id/generations/1/thumbnail/thumbnail.jpg',
        sizeBytes: 10n,
      }),
      uploadHls: vi.fn().mockResolvedValue({
        bucket: 'streams',
        storagePrefix: 'videos/video-id/generations/1/hls/',
        masterManifestKey: 'videos/video-id/generations/1/hls/master.m3u8',
        masterManifestSizeBytes: 10n,
        renditions: [
          {
            name: '360p',
            storagePrefix: 'videos/video-id/generations/1/hls/360p/',
            manifestKey: 'videos/video-id/generations/1/hls/360p/index.m3u8',
            segmentCount: 1,
          },
        ],
      }),
    };
    const mediaTools = {
      probe: vi.fn().mockResolvedValue({
        durationSeconds: 2,
        width: 640,
        height: 360,
        videoCodec: 'h264',
        audioCodec: null,
        container: 'mp4',
        frameRate: 30,
        bitrateKbps: 500,
        rotationDegrees: 0,
      }),
      generateThumbnail: vi.fn().mockResolvedValue({ width: 640, height: 360 }),
      generateHlsRendition: vi.fn(
        async (_input: string, _directory: string, spec: object) => ({
          spec,
          manifestPath: 'hls/360p/index.m3u8',
          segmentCount: 1,
        }),
      ),
      generateHlsMaster: vi.fn(),
    };
    const pipeline = new VideoProcessingPipeline(
      database as never,
      storage as never,
      mediaTools as never,
    );

    await pipeline.execute('job-id', {
      schemaVersion: 1,
      videoId: 'video-id',
      originalAssetId: 'asset-id',
      generation: 1,
      correlationId: 'request-id',
    });

    expect(storage.uploadHls).toHaveBeenCalledWith(
      'video-id',
      1,
      expect.any(String),
      ['360p'],
    );
    expect(storage.removeGenerated).toHaveBeenCalledTimes(2);
    expect(transaction.video.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'video-id',
          status: 'PROCESSING',
          processingGeneration: 1,
        },
      }),
    );
  });
});

describe('VideoProcessingPipeline generation ownership', () => {
  it('skips a job from an older generation before touching storage', async () => {
    const database = {
      video: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'video-id',
          status: 'PROCESSING',
          processingGeneration: 2,
          assets: [],
        }),
      },
    };
    const storage = { download: vi.fn() };
    const pipeline = new VideoProcessingPipeline(
      database as never,
      storage as never,
      {} as never,
    );

    await pipeline.execute('old-job', {
      schemaVersion: 1,
      videoId: 'video-id',
      originalAssetId: 'asset-id',
      generation: 1,
      correlationId: 'request-id',
    });

    expect(storage.download).not.toHaveBeenCalled();
  });

  it('does not upload when generation ownership changes during media work', async () => {
    const database = {
      video: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'video-id',
          status: 'PROCESSING',
          processingGeneration: 2,
          assets: [
            {
              id: 'asset-id',
              bucket: 'originals',
              objectKey: 'original.mp4',
              sizeBytes: 100n,
            },
          ],
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const storage = {
      download: vi.fn(),
      uploadThumbnail: vi.fn(),
      uploadHls: vi.fn(),
    };
    const mediaTools = {
      probe: vi.fn().mockResolvedValue({
        durationSeconds: 2,
        width: 640,
        height: 360,
        videoCodec: 'h264',
        audioCodec: null,
        container: 'mp4',
        frameRate: 30,
        bitrateKbps: 500,
        rotationDegrees: 0,
      }),
      generateThumbnail: vi.fn().mockResolvedValue({ width: 640, height: 360 }),
      generateHlsRendition: vi.fn(
        async (_input: string, _directory: string, spec: object) => ({
          spec,
          manifestPath: 'hls/360p/index.m3u8',
          segmentCount: 1,
        }),
      ),
      generateHlsMaster: vi.fn(),
    };
    const pipeline = new VideoProcessingPipeline(
      database as never,
      storage as never,
      mediaTools as never,
    );

    await pipeline.execute('job-id', {
      schemaVersion: 1,
      videoId: 'video-id',
      originalAssetId: 'asset-id',
      generation: 2,
      correlationId: 'request-id',
    });

    expect(storage.uploadThumbnail).not.toHaveBeenCalled();
    expect(storage.uploadHls).not.toHaveBeenCalled();
  });

  it('ignores a final failure from a stale generation', async () => {
    const database = {
      video: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const storage = { removeGenerated: vi.fn().mockResolvedValue(undefined) };
    const pipeline = new VideoProcessingPipeline(
      database as never,
      storage as never,
      {} as never,
    );

    await expect(
      pipeline.fail('video-id', 1, 'Safe failure reason'),
    ).resolves.toBe(false);
    expect(database.video.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ processingGeneration: 1 }),
      }),
    );
  });
});

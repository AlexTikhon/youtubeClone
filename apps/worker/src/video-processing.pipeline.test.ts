import { describe, expect, it, vi } from 'vitest';
import { VideoProcessingPipeline } from './video-processing.pipeline.js';

describe('VideoProcessingPipeline deletion barrier', () => {
  it('does not touch storage when deletion already owns the video', async () => {
    const database = {
      video: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'video-id',
          status: 'DELETING',
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
            assets: [
              {
                id: 'asset-id',
                bucket: 'originals',
                objectKey: 'original.mp4',
                sizeBytes: 100n,
              },
            ],
          })
          .mockResolvedValueOnce({ status: 'DELETING' }),
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
        objectKey: 'videos/video-id/thumbnail/thumbnail.jpg',
        sizeBytes: 10n,
      }),
      uploadHls: vi.fn().mockResolvedValue({
        bucket: 'streams',
        storagePrefix: 'videos/video-id/hls/',
        masterManifestKey: 'videos/video-id/hls/master.m3u8',
        masterManifestSizeBytes: 10n,
        renditions: [
          {
            name: '360p',
            storagePrefix: 'videos/video-id/hls/360p/',
            manifestKey: 'videos/video-id/hls/360p/index.m3u8',
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
      correlationId: 'request-id',
    });

    expect(storage.uploadHls).toHaveBeenCalledWith(
      'video-id',
      expect.any(String),
      ['360p'],
    );
    expect(storage.removeGenerated).toHaveBeenCalledTimes(2);
    expect(transaction.video.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'video-id', status: 'PROCESSING' },
      }),
    );
  });
});

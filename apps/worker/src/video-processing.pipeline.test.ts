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
});

import { describe, expect, it, vi } from 'vitest';

import {
  AttemptBusyError,
  AttemptOwnershipLostError,
} from './processing-error.js';
import { VideoProcessingPipeline } from './video-processing.pipeline.js';

const job = {
  schemaVersion: 1 as const,
  videoId: 'video-id',
  originalAssetId: 'asset-id',
  generation: 1,
  correlationId: 'request-id',
};

const uploadedVideo = {
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
};

const metadata = {
  durationSeconds: 2,
  width: 640,
  height: 360,
  videoCodec: 'h264',
  audioCodec: null,
  container: 'mp4',
  frameRate: 30,
  bitrateKbps: 500,
  rotationDegrees: 0,
};

function createMediaTools() {
  return {
    probe: vi.fn().mockResolvedValue(metadata),
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
}

function createStorage() {
  return {
    download: vi.fn(),
    removeAttempt: vi.fn().mockResolvedValue(undefined),
    removeObsoleteGenerated: vi.fn().mockResolvedValue(undefined),
    uploadThumbnail: vi.fn().mockResolvedValue({
      bucket: 'thumbnails',
      objectKey: 'videos/video-id/generations/1/attempts/a/thumbnail.jpg',
      sizeBytes: 10n,
    }),
    uploadHls: vi.fn().mockResolvedValue({
      bucket: 'streams',
      storagePrefix: 'videos/video-id/generations/1/attempts/a/hls/',
      masterManifestKey: 'videos/video-id/generations/1/attempts/a/hls/m.m3u8',
      masterManifestSizeBytes: 10n,
      renditions: [
        {
          name: '360p',
          storagePrefix: 'p/',
          manifestKey: 'p/index.m3u8',
          segmentCount: 1,
        },
      ],
    }),
  };
}

function createPipeline(
  database: unknown,
  storage: unknown,
  mediaTools: unknown = {},
) {
  return new VideoProcessingPipeline(
    database as never,
    storage as never,
    mediaTools as never,
    { leaseSeconds: 30, renewIntervalMs: 60_000, attemptMaxMs: 60_000 },
  );
}

describe('VideoProcessingPipeline deletion barrier', () => {
  it('does not touch storage when deletion already owns the video', async () => {
    const database = {
      video: {
        findUnique: vi.fn().mockResolvedValue({
          ...uploadedVideo,
          status: 'DELETING',
          assets: [],
        }),
      },
      $executeRaw: vi.fn(),
    };
    const storage = createStorage();

    await createPipeline(database, storage).execute('job-id', job);

    expect(database.$executeRaw).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('abandons the attempt and removes only its own output when deletion wins at commit', async () => {
    const transaction = {
      videoAsset: { update: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      video: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const database = {
      video: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(uploadedVideo)
          // classifyFailure
          .mockResolvedValueOnce({
            status: 'DELETING',
            processingGeneration: 1,
            processingAttemptId: null,
            committedAttemptId: null,
          })
          // cleanupUnpublished
          .mockResolvedValueOnce({ committedAttemptId: null }),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn(
        async (callback: (input: typeof transaction) => Promise<void>) =>
          callback(transaction),
      ),
    };
    const storage = createStorage();

    await createPipeline(database, storage, createMediaTools()).execute(
      'job-id',
      job,
    );

    expect(storage.uploadHls).toHaveBeenCalledWith(
      'video-id',
      1,
      expect.any(String),
      expect.any(String),
      ['360p'],
    );
    expect(storage.removeAttempt).toHaveBeenCalledOnce();
    expect(storage.removeAttempt).toHaveBeenCalledWith(
      'video-id',
      1,
      storage.uploadHls.mock.calls[0]![2],
    );
    expect(transaction.video.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'video-id',
          status: 'PROCESSING',
          processingGeneration: 1,
          processingAttemptId: storage.uploadHls.mock.calls[0]![2],
        },
      }),
    );
    expect(transaction.videoAsset.create).not.toHaveBeenCalled();
    expect(storage.removeObsoleteGenerated).not.toHaveBeenCalled();
  });

  it('keeps published output when the READY commit succeeded but its response was lost', async () => {
    const database = {
      video: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(uploadedVideo)
          .mockImplementation(() =>
            Promise.resolve({
              status: 'READY',
              processingGeneration: 1,
              processingAttemptId: null,
              committedAttemptId: committedAttemptId(),
            }),
          ),
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $transaction: vi.fn().mockRejectedValue(new Error('connection reset')),
    };
    const storage = createStorage();
    const committedAttemptId = () => storage.uploadHls.mock.calls[0]![2];

    await createPipeline(database, storage, createMediaTools()).execute(
      'job-id',
      job,
    );

    expect(storage.removeAttempt).not.toHaveBeenCalled();
    expect(storage.removeObsoleteGenerated).toHaveBeenCalledOnce();
  });
});

describe('VideoProcessingPipeline attempt ownership', () => {
  it('skips a job from an older generation before acquiring or touching storage', async () => {
    const database = {
      video: {
        findUnique: vi.fn().mockResolvedValue({
          ...uploadedVideo,
          status: 'PROCESSING',
          processingGeneration: 2,
          assets: [],
        }),
      },
      $executeRaw: vi.fn(),
    };
    const storage = createStorage();

    await createPipeline(database, storage).execute('old-job', job);

    expect(database.$executeRaw).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('rejects an execution while another attempt holds a live lease', async () => {
    const database = {
      video: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ ...uploadedVideo, status: 'PROCESSING' })
          .mockResolvedValueOnce({
            status: 'PROCESSING',
            processingGeneration: 1,
          }),
      },
      $executeRaw: vi.fn().mockResolvedValue(0),
    };
    const storage = createStorage();

    const rejected = createPipeline(database, storage).execute('job-id', job);

    await expect(rejected).rejects.toBeInstanceOf(AttemptBusyError);
    await expect(rejected).rejects.toMatchObject({ retryable: true });
    // No attempt was acquired, so nothing may be failed on its behalf.
    await expect(rejected).rejects.not.toHaveProperty('attemptId');
    expect(storage.download).not.toHaveBeenCalled();
    expect(storage.removeAttempt).not.toHaveBeenCalled();
  });

  it('does not upload when the lease was lost during media work', async () => {
    const database = {
      video: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(uploadedVideo)
          .mockResolvedValueOnce({
            status: 'PROCESSING',
            processingGeneration: 1,
            processingAttemptId: 'someone-else',
            committedAttemptId: null,
          })
          .mockResolvedValueOnce({ committedAttemptId: null }),
      },
      // Acquisition succeeds; the verified renewal before upload does not.
      $executeRaw: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0),
    };
    const storage = createStorage();

    const rejected = createPipeline(
      database,
      storage,
      createMediaTools(),
    ).execute('job-id', job);

    await expect(rejected).rejects.toBeInstanceOf(AttemptOwnershipLostError);
    await expect(rejected).rejects.toMatchObject({
      retryable: false,
      attemptId: expect.any(String),
    });
    expect(storage.uploadThumbnail).not.toHaveBeenCalled();
    expect(storage.uploadHls).not.toHaveBeenCalled();
    expect(storage.removeAttempt).toHaveBeenCalledOnce();
  });

  it('records a final failure only through the attempt-fenced update', async () => {
    const database = {
      video: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const storage = createStorage();
    const attempt = {
      videoId: 'video-id',
      generation: 1,
      attemptId: 'attempt-id',
    };

    await expect(
      createPipeline(database, storage).fail(attempt, 'Safe failure reason'),
    ).resolves.toBe(false);

    expect(database.video.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'video-id',
          status: 'PROCESSING',
          processingGeneration: 1,
          processingAttemptId: 'attempt-id',
        },
      }),
    );
    // A rejected failure never deletes anything: the winner may own the output.
    expect(storage.removeAttempt).not.toHaveBeenCalled();
  });

  it('removes only its own unpublished output after recording its own failure', async () => {
    const database = {
      video: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({ committedAttemptId: null }),
      },
    };
    const storage = createStorage();

    await expect(
      createPipeline(database, storage).fail(
        { videoId: 'video-id', generation: 1, attemptId: 'attempt-id' },
        'Safe failure reason',
      ),
    ).resolves.toBe(true);

    expect(storage.removeAttempt).toHaveBeenCalledWith(
      'video-id',
      1,
      'attempt-id',
    );
  });
});

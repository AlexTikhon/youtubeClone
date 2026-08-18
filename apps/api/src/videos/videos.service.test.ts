import { describe, expect, it, vi } from 'vitest';
import {
  ObjectNotFoundError,
  ObjectStorageUnavailableError,
} from '../infrastructure/storage/storage.port.js';
import { VideosService } from './videos.service.js';

const privateVideo = {
  id: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
  channelId: 'channel-id',
  title: 'Private video',
  description: null,
  status: 'READY' as const,
  visibility: 'PRIVATE' as const,
  durationSeconds: 30,
  publishedAt: null,
  processingGeneration: 1,
  processingStartedAt: null,
  processingFinishedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  channel: {
    id: 'channel-id',
    name: 'Owner',
    handle: 'owner',
    ownerId: 'owner-id',
    avatarUrl: null,
    _count: { subscriptions: 0 },
  },
  assets: [
    {
      id: 'manifest',
      objectKey:
        'videos/ad358d90-fbd5-4ef5-b567-c620b3f0fca0/hls/720p/index.m3u8',
    },
  ],
  _count: { likes: 0, views: 0 },
  likes: [],
  watchHistory: [],
};

describe('VideosService authorization and publishing', () => {
  it.each([
    ['PUBLIC', undefined, true],
    ['UNLISTED', undefined, true],
    ['PRIVATE', 'owner-id', true],
    ['PRIVATE', undefined, false],
  ] as const)(
    'enforces %s media access for caller %s',
    async (visibility, userId, allowed) => {
      const prisma = {
        video: {
          findUnique: vi.fn().mockResolvedValue({
            id: privateVideo.id,
            status: 'READY',
            visibility,
            durationSeconds: 30,
            channel: { ownerId: 'owner-id' },
          }),
        },
      };
      const service = new VideosService(
        prisma as never,
        {} as never,
        {} as never,
      );
      const result = service.assertMediaAccess(privateVideo.id, userId);

      if (allowed) {
        await expect(result).resolves.toMatchObject({ visibility });
      } else {
        await expect(result).rejects.toMatchObject({
          code: 'VIDEO_NOT_FOUND',
          status: 404,
        });
      }
    },
  );

  it('returns an owned private ready video without exposing failure data', async () => {
    const prisma = {
      video: { findUnique: vi.fn().mockResolvedValue(privateVideo) },
      subscription: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new VideosService(
      prisma as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.getWatch(privateVideo.id, 'owner-id'),
    ).resolves.toMatchObject({
      id: privateVideo.id,
      playbackUrl: `/api/v1/media/videos/${privateVideo.id}/hls/720p/index.m3u8`,
    });
  });

  it('points new videos at the ABR master without breaking legacy manifests', async () => {
    const prisma = {
      video: {
        findUnique: vi.fn().mockResolvedValue({
          ...privateVideo,
          assets: [
            {
              id: 'manifest',
              objectKey: `videos/${privateVideo.id}/hls/master.m3u8`,
            },
          ],
        }),
      },
      subscription: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new VideosService(
      prisma as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.getWatch(privateVideo.id, 'owner-id'),
    ).resolves.toMatchObject({
      playbackUrl: `/api/v1/media/videos/${privateVideo.id}/hls/master.m3u8`,
    });
  });

  it('hides a private video from an anonymous caller', async () => {
    const prisma = {
      video: { findUnique: vi.fn().mockResolvedValue(privateVideo) },
    };
    const service = new VideosService(
      prisma as never,
      {} as never,
      {} as never,
    );
    await expect(service.getWatch(privateVideo.id)).rejects.toMatchObject({
      code: 'VIDEO_NOT_FOUND',
      status: 404,
    });
  });

  it('retains the original publishedAt when a ready video is republished', async () => {
    const publishedAt = new Date('2026-01-01T00:00:00Z');
    const prisma = {
      video: {
        findFirst: vi.fn().mockResolvedValue({
          id: privateVideo.id,
          status: 'READY',
          visibility: 'PRIVATE',
          publishedAt,
        }),
        update: vi.fn().mockResolvedValue({
          ...privateVideo,
          visibility: 'PUBLIC',
          publishedAt,
          createdAt: publishedAt,
          width: 1,
          height: 1,
          failureReason: null,
          channel: { name: 'Owner', handle: 'owner' },
          assets: [],
          _count: { views: 0, likes: 0, comments: 0 },
        }),
      },
    };
    const service = new VideosService(
      prisma as never,
      {} as never,
      {} as never,
    );
    await service.update(privateVideo.id, 'owner-id', { visibility: 'PUBLIC' });
    expect(prisma.video.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ publishedAt }),
      }),
    );
  });

  it('publishes after a processing completion wins the visibility-update race', async () => {
    const createdAt = new Date('2026-08-16T10:00:00Z');
    const readyRecord = {
      ...privateVideo,
      status: 'READY' as const,
      visibility: 'PUBLIC' as const,
      createdAt,
      width: 1280,
      height: 720,
      failureReason: null,
      channel: { name: 'Owner', handle: 'owner' },
      assets: [],
      _count: { views: 0, likes: 0, comments: 0 },
    };
    const prisma = {
      video: {
        findFirst: vi.fn().mockResolvedValue({
          id: privateVideo.id,
          status: 'PROCESSING',
          visibility: 'PRIVATE',
          publishedAt: null,
        }),
        update: vi
          .fn()
          .mockResolvedValueOnce({ ...readyRecord, publishedAt: null })
          .mockResolvedValueOnce({ ...readyRecord, publishedAt: createdAt }),
      },
    };
    const service = new VideosService(
      prisma as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.update(privateVideo.id, 'owner-id', { visibility: 'PUBLIC' }),
    ).resolves.toMatchObject({ publishedAt: createdAt.toISOString() });
    expect(prisma.video.update).toHaveBeenCalledTimes(2);
  });
});

describe('VideosService processing retry', () => {
  const failedVideo = {
    id: privateVideo.id,
    status: 'FAILED' as const,
    processingGeneration: 1,
    assets: [
      {
        id: 'original-id',
        kind: 'ORIGINAL',
        bucket: 'originals',
        objectKey: 'originals/video/file.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 100n,
      },
    ],
  };

  function createRetryService(video = failedVideo) {
    const transaction = {
      video: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      processingOutbox: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      video: { findFirst: vi.fn().mockResolvedValue(video) },
      $transaction: vi.fn(
        async (callback: (input: typeof transaction) => Promise<void>) =>
          callback(transaction),
      ),
    };
    const storage = {
      headObject: vi.fn().mockResolvedValue({
        contentType: 'video/mp4',
        sizeBytes: 100n,
      }),
    };
    return {
      service: new VideosService(
        prisma as never,
        storage as never,
        {} as never,
      ),
      prisma,
      storage,
      transaction,
    };
  }

  it('atomically increments the generation and writes an outbox event', async () => {
    const { service, transaction } = createRetryService();
    await expect(
      service.retryProcessing(failedVideo.id, 'owner-id', 'request-id'),
    ).resolves.toEqual({
      videoId: failedVideo.id,
      status: 'PROCESSING',
      processingGeneration: 2,
    });
    expect(transaction.video.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'FAILED',
          processingGeneration: 1,
        }),
        data: expect.objectContaining({
          status: 'PROCESSING',
          processingGeneration: 2,
        }),
      }),
    );
    expect(transaction.processingOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        generation: 2,
        originalAssetId: 'original-id',
      }),
    });
  });

  it.each(['READY', 'PROCESSING', 'DELETING'] as const)(
    'rejects retry from %s',
    async (status) => {
      const { service, transaction } = createRetryService({
        ...failedVideo,
        status,
      } as never);
      await expect(
        service.retryProcessing(failedVideo.id, 'owner-id', 'request-id'),
      ).rejects.toMatchObject({ status: 409 });
      expect(transaction.processingOutbox.create).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing ORIGINAL asset', async () => {
    const { service } = createRetryService({
      ...failedVideo,
      assets: [],
    });
    await expect(
      service.retryProcessing(failedVideo.id, 'owner-id', 'request-id'),
    ).rejects.toMatchObject({ code: 'VIDEO_ORIGINAL_MISSING', status: 409 });
  });

  it('rejects a missing original storage object', async () => {
    const { service, storage } = createRetryService();
    storage.headObject.mockRejectedValueOnce(new ObjectNotFoundError());
    await expect(
      service.retryProcessing(failedVideo.id, 'owner-id', 'request-id'),
    ).rejects.toMatchObject({
      code: 'VIDEO_ORIGINAL_OBJECT_MISSING',
      status: 409,
    });
  });

  it('reports storage downtime as retryable infrastructure failure', async () => {
    const { service, storage } = createRetryService();
    storage.headObject.mockRejectedValueOnce(
      new ObjectStorageUnavailableError(),
    );
    await expect(
      service.retryProcessing(failedVideo.id, 'owner-id', 'request-id'),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
  });

  it('allows exactly one of two concurrent retry claims', async () => {
    const { service, transaction } = createRetryService();
    transaction.video.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const results = await Promise.allSettled([
      service.retryProcessing(failedVideo.id, 'owner-id', 'request-a'),
      service.retryProcessing(failedVideo.id, 'owner-id', 'request-b'),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(transaction.processingOutbox.create).toHaveBeenCalledTimes(1);
  });
});

describe('VideosService deletion barrier', () => {
  it('does not delete the database row after partial storage cleanup fails', async () => {
    const prisma = {
      video: {
        findFirst: vi.fn().mockResolvedValue({
          id: privateVideo.id,
          status: 'DELETING',
          assets: [],
          upload: null,
        }),
        delete: vi.fn(),
      },
    };
    const storage = {
      deleteObject: vi.fn(),
      deletePrefix: vi
        .fn()
        .mockRejectedValue(new ObjectStorageUnavailableError()),
    };
    const service = new VideosService(
      prisma as never,
      storage as never,
      {
        S3_BUCKET_STREAMS: 'streams',
        S3_BUCKET_THUMBNAILS: 'thumbnails',
      } as never,
    );

    await expect(
      service.delete(privateVideo.id, 'owner-id'),
    ).rejects.toMatchObject({ code: 'VIDEO_DELETE_FAILED', status: 503 });
    expect(prisma.video.delete).not.toHaveBeenCalled();
  });
});

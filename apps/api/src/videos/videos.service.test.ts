import { describe, expect, it, vi } from 'vitest';
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
  channel: {
    id: 'channel-id',
    name: 'Owner',
    handle: 'owner',
    ownerId: 'owner-id',
    avatarUrl: null,
    _count: { subscriptions: 0 },
  },
  assets: [{ id: 'manifest' }],
  _count: { likes: 0, views: 0 },
  likes: [],
  watchHistory: [],
};

describe('VideosService authorization and publishing', () => {
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
      playbackUrl: expect.any(String),
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

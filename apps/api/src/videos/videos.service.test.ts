import { describe, expect, it, vi } from 'vitest';

import { VideosService } from './videos.service.js';

const privateVideo = {
  id: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
  title: 'Private video',
  description: null,
  status: 'READY' as const,
  visibility: 'PRIVATE' as const,
  durationSeconds: 3,
  width: 320,
  height: 180,
  failureReason: null,
  publishedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  channel: { name: 'Owner', handle: 'owner', ownerId: 'owner-id' },
  assets: [{ kind: 'THUMBNAIL' as const }, { kind: 'HLS_MANIFEST' as const }],
};

describe('VideosService authorization', () => {
  it('returns a private video to its owner', async () => {
    const prisma = {
      video: { findUnique: vi.fn().mockResolvedValue(privateVideo) },
    };
    const service = new VideosService(prisma as never);
    await expect(
      service.getVisible(privateVideo.id, 'owner-id'),
    ).resolves.toMatchObject({
      id: privateVideo.id,
      status: 'READY',
    });
  });

  it('hides a private video from an anonymous caller', async () => {
    const prisma = {
      video: { findUnique: vi.fn().mockResolvedValue(privateVideo) },
    };
    const service = new VideosService(prisma as never);
    await expect(service.getVisible(privateVideo.id)).rejects.toMatchObject({
      code: 'VIDEO_NOT_FOUND',
      status: 404,
    });
  });
});

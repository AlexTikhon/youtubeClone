import { describe, expect, it, vi } from 'vitest';
import { PlaylistsService } from './playlists.service.js';

const standardPlaylist = {
  id: '28db20dd-038f-4de1-8976-e1056773cfc9',
  ownerId: 'owner',
  title: 'Learning',
  description: null,
  visibility: 'PRIVATE' as const,
  type: 'STANDARD' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('PlaylistsService invariants', () => {
  it('rejects another user before changing a playlist', async () => {
    const prisma = {
      playlist: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    };
    const service = new PlaylistsService(prisma as never);
    await expect(
      service.update(standardPlaylist.id, 'another-user', { title: 'Nope' }),
    ).rejects.toMatchObject({ code: 'PLAYLIST_NOT_FOUND', status: 404 });
    expect(prisma.playlist.update).not.toHaveBeenCalled();
  });

  it('does not allow Watch Later deletion', async () => {
    const prisma = {
      playlist: {
        findFirst: vi.fn().mockResolvedValue({
          ...standardPlaylist,
          type: 'WATCH_LATER',
        }),
        delete: vi.fn(),
      },
    };
    const service = new PlaylistsService(prisma as never);
    await expect(
      service.delete(standardPlaylist.id, 'owner'),
    ).rejects.toMatchObject({ code: 'SYSTEM_PLAYLIST_IMMUTABLE' });
    expect(prisma.playlist.delete).not.toHaveBeenCalled();
  });

  it('uses deleteMany so repeated video removal is idempotent', async () => {
    const transaction = vi.fn().mockResolvedValue([]);
    const prisma = {
      playlist: {
        findFirst: vi.fn().mockResolvedValue(standardPlaylist),
        update: vi.fn().mockReturnValue(Promise.resolve(standardPlaylist)),
      },
      playlistItem: {
        deleteMany: vi.fn().mockReturnValue(Promise.resolve({ count: 0 })),
      },
      $transaction: transaction,
    };
    const service = new PlaylistsService(prisma as never);
    await expect(
      service.removeVideo(standardPlaylist.id, 'video', 'owner'),
    ).resolves.toEqual({ saved: false });
    expect(prisma.playlistItem.deleteMany).toHaveBeenCalled();
  });
});

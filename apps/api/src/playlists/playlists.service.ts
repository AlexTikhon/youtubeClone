import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CursorPage,
  PlaylistDetailDto,
  PlaylistSummaryDto,
  VideoCardDto,
} from '@youtube-clone/types';
import type {
  CreatePlaylistInput,
  UpdatePlaylistInput,
} from '@youtube-clone/validation';
import { z } from 'zod';

import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { AppError } from '../infrastructure/http/app-error.js';
import { decodeCursor, encodeCursor } from '../infrastructure/http/cursor.js';

const MAX_PLAYLIST_ITEMS = 200;
const mineCursorSchema = z.object({
  updatedAt: z.string().datetime(),
  id: z.string().uuid(),
});

@Injectable()
export class PlaylistsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(
    ownerId: string,
    input: CreatePlaylistInput,
  ): Promise<PlaylistSummaryDto> {
    const playlist = await this.prisma.playlist.create({
      data: { ownerId, ...input, type: 'STANDARD' },
    });
    return this.toSummary(playlist, 0, null, false);
  }

  async mine(
    ownerId: string,
    cursor: string | undefined,
    limit: number,
    videoId?: string,
  ): Promise<CursorPage<PlaylistSummaryDto>> {
    await this.ensureWatchLater(ownerId);
    const after = cursor ? decodeCursor(cursor, mineCursorSchema) : undefined;
    const playlists = await this.prisma.playlist.findMany({
      where: {
        ownerId,
        ...(after
          ? {
              OR: [
                { updatedAt: { lt: new Date(after.updatedAt) } },
                {
                  updatedAt: new Date(after.updatedAt),
                  id: { lt: after.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        _count: { select: { items: true } },
        items: {
          where: {
            video: {
              status: 'READY',
              visibility: 'PUBLIC',
              publishedAt: { not: null },
              durationSeconds: { not: null },
              assets: { some: { kind: 'THUMBNAIL' } },
            },
          },
          orderBy: [{ position: 'asc' }],
          take: 1,
          select: { videoId: true },
        },
      },
    });
    const selected = playlists.slice(0, limit);
    const memberships = videoId
      ? await this.prisma.playlistItem.findMany({
          where: {
            videoId,
            playlistId: { in: selected.map((playlist) => playlist.id) },
          },
          select: { playlistId: true },
        })
      : [];
    const membershipIds = new Set(memberships.map((item) => item.playlistId));
    const data = selected.map((playlist) =>
      this.toSummary(
        playlist,
        playlist._count.items,
        playlist.items[0]?.videoId ?? null,
        membershipIds.has(playlist.id),
      ),
    );
    const last = selected.at(-1);
    const hasMore = playlists.length > limit;
    return {
      data,
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                updatedAt: last.updatedAt.toISOString(),
                id: last.id,
              })
            : null,
      },
    };
  }

  async get(playlistId: string, userId?: string): Promise<PlaylistDetailDto> {
    const playlist = await this.prisma.playlist.findUnique({
      where: { id: playlistId },
      include: {
        owner: { select: { id: true, username: true } },
      },
    });
    const owned = playlist?.ownerId === userId;
    if (!playlist || (playlist.visibility === 'PRIVATE' && !owned)) {
      throw new AppError('PLAYLIST_NOT_FOUND', 'Playlist was not found', 404);
    }
    const items = await this.prisma.playlistItem.findMany({
      where: {
        playlistId,
        video: {
          status: 'READY',
          visibility: 'PUBLIC',
          publishedAt: { not: null },
          durationSeconds: { not: null },
          assets: { some: { kind: 'HLS_MANIFEST' } },
          AND: { assets: { some: { kind: 'THUMBNAIL' } } },
        },
      },
      orderBy: [{ position: 'asc' }, { videoId: 'asc' }],
      take: MAX_PLAYLIST_ITEMS,
      include: {
        video: {
          include: {
            channel: {
              select: { id: true, name: true, handle: true, avatarUrl: true },
            },
            _count: { select: { views: true } },
          },
        },
      },
    });
    return {
      id: playlist.id,
      title: playlist.title,
      description: playlist.description,
      visibility: playlist.visibility,
      type: playlist.type,
      owner: playlist.owner,
      ownedByCurrentUser: owned,
      videoCount: items.length,
      videos: items.map((item) => ({
        position: item.position,
        addedAt: item.addedAt.toISOString(),
        video: this.toCard(item.video),
      })),
    };
  }

  async update(
    playlistId: string,
    ownerId: string,
    input: UpdatePlaylistInput,
  ): Promise<PlaylistDetailDto> {
    const playlist = await this.findOwned(playlistId, ownerId);
    if (playlist.type === 'WATCH_LATER') {
      throw new AppError(
        'SYSTEM_PLAYLIST_IMMUTABLE',
        'Watch Later settings cannot be changed',
        409,
      );
    }
    await this.prisma.playlist.update({
      where: { id: playlistId },
      data: input,
    });
    return this.get(playlistId, ownerId);
  }

  async delete(
    playlistId: string,
    ownerId: string,
  ): Promise<{ deleted: true }> {
    const playlist = await this.findOwned(playlistId, ownerId);
    if (playlist.type === 'WATCH_LATER') {
      throw new AppError(
        'SYSTEM_PLAYLIST_IMMUTABLE',
        'Watch Later cannot be deleted',
        409,
      );
    }
    await this.prisma.playlist.delete({ where: { id: playlistId } });
    return { deleted: true };
  }

  async addVideo(
    playlistId: string,
    videoId: string,
    ownerId: string,
  ): Promise<{ saved: true }> {
    const playlist = await this.findOwned(playlistId, ownerId);
    const video = await this.prisma.video.findFirst({
      where: {
        id: videoId,
        status: 'READY',
        visibility: 'PUBLIC',
        publishedAt: { not: null },
        durationSeconds: { not: null },
        assets: { some: { kind: 'HLS_MANIFEST' } },
      },
      select: { id: true },
    });
    if (!video)
      throw new AppError('VIDEO_NOT_FOUND', 'Video was not found', 404);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${playlistId}, 0))
      `;
      const existing = await transaction.playlistItem.findUnique({
        where: { playlistId_videoId: { playlistId, videoId } },
        select: { videoId: true },
      });
      if (existing) return;
      const count = await transaction.playlistItem.count({
        where: { playlistId },
      });
      if (count >= MAX_PLAYLIST_ITEMS) {
        throw new AppError(
          'PLAYLIST_FULL',
          `A playlist can contain at most ${MAX_PLAYLIST_ITEMS} videos`,
          409,
        );
      }
      const maximum = await transaction.playlistItem.aggregate({
        where: { playlistId },
        _max: { position: true },
      });
      await transaction.playlistItem.create({
        data: {
          playlistId,
          videoId,
          position: (maximum._max.position ?? 0) + 1,
        },
      });
      await transaction.playlist.update({
        where: { id: playlist.id },
        data: { updatedAt: new Date() },
      });
    });
    return { saved: true };
  }

  async removeVideo(
    playlistId: string,
    videoId: string,
    ownerId: string,
  ): Promise<{ saved: false }> {
    await this.findOwned(playlistId, ownerId);
    await this.prisma.$transaction([
      this.prisma.playlistItem.deleteMany({ where: { playlistId, videoId } }),
      this.prisma.playlist.update({
        where: { id: playlistId },
        data: { updatedAt: new Date() },
      }),
    ]);
    return { saved: false };
  }

  private async ensureWatchLater(ownerId: string) {
    const existing = await this.prisma.playlist.findFirst({
      where: { ownerId, type: 'WATCH_LATER' },
    });
    if (existing) return existing;
    try {
      return await this.prisma.playlist.create({
        data: {
          ownerId,
          title: 'Watch Later',
          visibility: 'PRIVATE',
          type: 'WATCH_LATER',
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return this.prisma.playlist.findFirstOrThrow({
          where: { ownerId, type: 'WATCH_LATER' },
        });
      }
      throw error;
    }
  }

  private async findOwned(playlistId: string, ownerId: string) {
    const playlist = await this.prisma.playlist.findFirst({
      where: { id: playlistId, ownerId },
    });
    if (!playlist)
      throw new AppError('PLAYLIST_NOT_FOUND', 'Playlist was not found', 404);
    return playlist;
  }

  private toSummary(
    playlist: {
      id: string;
      title: string;
      description: string | null;
      visibility: 'PRIVATE' | 'PUBLIC';
      type: 'STANDARD' | 'WATCH_LATER';
      updatedAt: Date;
    },
    videoCount: number,
    coverVideoId: string | null,
    containsVideo: boolean,
  ): PlaylistSummaryDto {
    return {
      id: playlist.id,
      title: playlist.title,
      description: playlist.description,
      visibility: playlist.visibility,
      type: playlist.type,
      videoCount,
      coverThumbnailUrl: coverVideoId
        ? `/api/v1/media/videos/${coverVideoId}/thumbnail`
        : null,
      updatedAt: playlist.updatedAt.toISOString(),
      containsVideo,
    };
  }

  private toCard(video: {
    id: string;
    title: string;
    durationSeconds: number | null;
    publishedAt: Date | null;
    channel: {
      id: string;
      name: string;
      handle: string;
      avatarUrl: string | null;
    };
    _count: { views: number };
  }): VideoCardDto {
    if (video.durationSeconds === null || video.publishedAt === null) {
      throw new Error('Playlist card requires playable publication metadata');
    }
    return {
      id: video.id,
      title: video.title,
      durationSeconds: video.durationSeconds,
      thumbnailUrl: `/api/v1/media/videos/${video.id}/thumbnail`,
      viewsCount: video._count.views,
      publishedAt: video.publishedAt.toISOString(),
      channel: video.channel,
    };
  }
}

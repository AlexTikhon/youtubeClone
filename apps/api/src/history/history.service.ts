import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { decodeCursor, encodeCursor } from '../infrastructure/http/cursor.js';
import { VideosService } from '../videos/videos.service.js';
import { isViewEligible, utcDayWindow } from './view-policy.js';

interface HistoryCursor {
  date: string;
  id: string;
}
const historyCursorSchema = z.object({
  date: z.string().datetime(),
  id: z.string().uuid(),
});

@Injectable()
export class HistoryService {
  private readonly logger = new Logger(HistoryService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideosService) private readonly videos: VideosService,
  ) {}

  async recordView(videoId: string, userId: string, watchedSeconds: number) {
    const video = await this.videos.assertWatchAccess(videoId, userId);
    if (!isViewEligible(video.durationSeconds ?? 0, watchedSeconds)) {
      return {
        counted: false,
        viewsCount: await this.prisma.videoView.count({ where: { videoId } }),
      };
    }
    const result = await this.prisma.videoView.createMany({
      data: [{ userId, videoId, windowStart: utcDayWindow(new Date()) }],
      skipDuplicates: true,
    });
    const viewsCount = await this.prisma.videoView.count({
      where: { videoId },
    });
    if (result.count === 1)
      this.logger.log({ event: 'video.view.counted', videoId, userId });
    return { counted: result.count === 1, viewsCount };
  }

  async update(videoId: string, userId: string, positionSeconds: number) {
    const video = await this.videos.assertWatchAccess(videoId, userId);
    const position = Math.max(
      0,
      Math.min(
        Math.floor(positionSeconds),
        video.durationSeconds ?? Math.floor(positionSeconds),
      ),
    );
    await this.prisma.watchHistory.upsert({
      where: { userId_videoId: { userId, videoId } },
      create: { userId, videoId, lastPositionSeconds: position },
      update: { lastPositionSeconds: position, lastWatchedAt: new Date() },
    });
    return { saved: true, positionSeconds: position };
  }

  async list(userId: string, cursor: string | undefined, limit: number) {
    const after = cursor
      ? decodeCursor<HistoryCursor>(cursor, historyCursorSchema)
      : undefined;
    const rows = await this.prisma.watchHistory.findMany({
      where: {
        userId,
        video: {
          status: 'READY',
          durationSeconds: { not: null },
          assets: { some: { kind: 'HLS_MANIFEST' } },
          AND: { assets: { some: { kind: 'THUMBNAIL' } } },
          OR: [
            { visibility: { in: ['PUBLIC', 'UNLISTED'] } },
            { channel: { ownerId: userId } },
          ],
        },
        ...(after
          ? {
              OR: [
                { lastWatchedAt: { lt: new Date(after.date) } },
                {
                  lastWatchedAt: new Date(after.date),
                  videoId: { lt: after.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ lastWatchedAt: 'desc' }, { videoId: 'desc' }],
      take: limit + 1,
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
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((row) => ({
      video: {
        id: row.video.id,
        title: row.video.title,
        durationSeconds: row.video.durationSeconds!,
        thumbnailUrl: `/api/v1/media/videos/${row.video.id}/thumbnail`,
        viewsCount: row.video._count.views,
        channel: row.video.channel,
        publishedAt: row.video.publishedAt?.toISOString() ?? null,
      },
      lastPositionSeconds: row.lastPositionSeconds,
      lastWatchedAt: row.lastWatchedAt.toISOString(),
    }));
    const last = rows.slice(0, limit).at(-1);
    return {
      data,
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                date: last.lastWatchedAt.toISOString(),
                id: last.videoId,
              })
            : null,
      },
    };
  }

  async remove(videoId: string, userId: string) {
    await this.prisma.watchHistory.deleteMany({ where: { userId, videoId } });
    return { deleted: true };
  }
}

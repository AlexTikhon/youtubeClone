import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { decodeCursor, encodeCursor } from '../infrastructure/http/cursor.js';
import { VideosService } from '../videos/videos.service.js';
import { compareRanked, feedScore } from './ranking.js';

interface FeedCursor {
  asOf: string;
  score: number;
  publishedAt: string;
  id: string;
}
interface DateIdCursor {
  date: string;
  id: string;
}

@Injectable()
export class FeedsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideosService) private readonly videos: VideosService,
  ) {}

  async home(
    userId: string | undefined,
    cursor: string | undefined,
    limit: number,
  ) {
    const decoded = cursor ? decodeCursor<FeedCursor>(cursor) : undefined;
    const asOf = decoded ? new Date(decoded.asOf) : new Date();
    const commonWhere = {
      status: 'READY' as const,
      visibility: 'PUBLIC' as const,
      publishedAt: { not: null, lte: asOf },
      durationSeconds: { not: null },
      assets: { some: { kind: 'HLS_MANIFEST' as const } },
      AND: { assets: { some: { kind: 'THUMBNAIL' as const } } },
    };
    const include = {
      channel: {
        select: { id: true, name: true, handle: true, avatarUrl: true },
      },
      _count: { select: { views: true, likes: true } },
    } as const;
    const [recent, popular, subscriptions, watched] = await Promise.all([
      this.prisma.video.findMany({
        where: commonWhere,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: 150,
        include,
      }),
      this.prisma.video.findMany({
        where: commonWhere,
        orderBy: { views: { _count: 'desc' } },
        take: 75,
        include,
      }),
      userId
        ? this.prisma.video.findMany({
            where: {
              ...commonWhere,
              channel: { subscriptions: { some: { subscriberId: userId } } },
            },
            orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
            take: 75,
            include,
          })
        : Promise.resolve([]),
      userId
        ? this.prisma.watchHistory.findMany({
            where: {
              userId,
              lastWatchedAt: {
                gte: new Date(asOf.getTime() - 7 * 86_400_000),
                lte: asOf,
              },
            },
            select: { videoId: true },
            take: 200,
          })
        : Promise.resolve([]),
    ]);
    const watchedIds = new Set(watched.map((entry) => entry.videoId));
    const subscribedChannelIds = new Set(
      subscriptions.map((video) => video.channelId),
    );
    const candidates = new Map(
      [...recent, ...popular, ...subscriptions].map((video) => [
        video.id,
        video,
      ]),
    );
    const ranked = [...candidates.values()]
      .map((video) => ({
        video,
        score: feedScore(
          {
            publishedAt: video.publishedAt!,
            viewsCount: video._count.views,
            likesCount: video._count.likes,
            subscribed: subscribedChannelIds.has(video.channelId),
            watchedRecently: watchedIds.has(video.id),
          },
          asOf,
        ),
      }))
      .sort((a, b) =>
        compareRanked(
          { ...a.video, score: a.score, publishedAt: a.video.publishedAt! },
          { ...b.video, score: b.score, publishedAt: b.video.publishedAt! },
        ),
      );
    const after = decoded
      ? ranked.filter(
          ({ video, score }) =>
            score < decoded.score ||
            (score === decoded.score &&
              (video.publishedAt!.toISOString() < decoded.publishedAt ||
                (video.publishedAt!.toISOString() === decoded.publishedAt &&
                  video.id < decoded.id))),
        )
      : ranked;
    const pageRows = after.slice(0, limit + 1);
    const hasMore = pageRows.length > limit;
    const selected = pageRows.slice(0, limit);
    const data = selected.map(({ video }) => this.videos.toCardDto(video));
    const last = selected.at(-1);
    return {
      data,
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                asOf: asOf.toISOString(),
                score: last.score,
                publishedAt: last.video.publishedAt!.toISOString(),
                id: last.video.id,
              })
            : null,
      },
    };
  }

  async subscriptions(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const after = cursor ? decodeCursor<DateIdCursor>(cursor) : undefined;
    const rows = await this.prisma.video.findMany({
      where: {
        status: 'READY',
        visibility: 'PUBLIC',
        publishedAt: { not: null },
        durationSeconds: { not: null },
        channel: { subscriptions: { some: { subscriberId: userId } } },
        assets: { some: { kind: 'HLS_MANIFEST' } },
        AND: { assets: { some: { kind: 'THUMBNAIL' } } },
        ...(after
          ? {
              OR: [
                { publishedAt: { lt: new Date(after.date) } },
                { publishedAt: new Date(after.date), id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        channel: {
          select: { id: true, name: true, handle: true, avatarUrl: true },
        },
        _count: { select: { views: true } },
      },
    });
    const hasMore = rows.length > limit;
    const data = rows
      .slice(0, limit)
      .map((video) => this.videos.toCardDto(video));
    const last = data.at(-1);
    return {
      data,
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({ date: last.publishedAt, id: last.id })
            : null,
      },
    };
  }
}

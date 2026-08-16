import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CursorPage, VideoCardDto } from '@youtube-clone/types';
import { z } from 'zod';

import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { decodeCursor, encodeCursor } from '../infrastructure/http/cursor.js';
import { VideosService } from '../videos/videos.service.js';

interface SearchCursor {
  asOf: string;
  rank: number;
  publishedAt: string;
  id: string;
}

const searchCursorSchema = z.object({
  asOf: z.string().datetime(),
  rank: z.number().finite().nonnegative(),
  publishedAt: z.string().datetime(),
  id: z.string().uuid(),
});

const rawVideoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  durationSeconds: z.coerce.number().int().positive(),
  publishedAt: z.coerce.date(),
  viewsCount: z.coerce.number().int().nonnegative(),
  channelId: z.string().uuid(),
  channelName: z.string(),
  channelHandle: z.string(),
  channelAvatarUrl: z.string().nullable(),
  rank: z.coerce.number().finite().nonnegative(),
});
type RawVideo = z.infer<typeof rawVideoSchema>;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideosService) private readonly videos: VideosService,
  ) {}

  async search(
    query: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<VideoCardDto>> {
    const startedAt = performance.now();
    const after = cursor
      ? decodeCursor<SearchCursor>(cursor, searchCursorSchema)
      : undefined;
    const asOf = after ? new Date(after.asOf) : new Date();
    const cursorClause = after
      ? Prisma.sql`AND (
          ranked.rank < ${after.rank}
          OR (ranked.rank = ${after.rank} AND ranked."publishedAt" < ${new Date(after.publishedAt)})
          OR (ranked.rank = ${after.rank} AND ranked."publishedAt" = ${new Date(after.publishedAt)} AND ranked.id < ${after.id}::uuid)
        )`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<unknown[]>(Prisma.sql`
      WITH search_query AS (
        SELECT websearch_to_tsquery('english', ${query}) AS value
      ), ranked AS (
        SELECT
          video.id,
          video.title,
          video."durationSeconds",
          video."publishedAt",
          COUNT(view_record.id)::int AS "viewsCount",
          channel.id AS "channelId",
          channel.name AS "channelName",
          channel.handle AS "channelHandle",
          channel."avatarUrl" AS "channelAvatarUrl",
          ROUND((
            ts_rank_cd(video."searchVector", search_query.value) * 1000
            + LEAST(LN(1 + COUNT(view_record.id)), 10) * 0.5
            + GREATEST(0, 2 - EXTRACT(EPOCH FROM (${asOf}::timestamptz - video."publishedAt")) / 2592000)
          )::numeric, 6)::double precision AS rank
        FROM "Video" AS video
        JOIN "Channel" AS channel ON channel.id = video."channelId"
        CROSS JOIN search_query
        LEFT JOIN "VideoView" AS view_record ON view_record."videoId" = video.id
        WHERE video.status = 'READY'
          AND video.visibility = 'PUBLIC'
          AND video."publishedAt" IS NOT NULL
          AND video."durationSeconds" IS NOT NULL
          AND video."searchVector" @@ search_query.value
          AND EXISTS (SELECT 1 FROM "VideoAsset" asset WHERE asset."videoId" = video.id AND asset.kind = 'HLS_MANIFEST')
          AND EXISTS (SELECT 1 FROM "VideoAsset" asset WHERE asset."videoId" = video.id AND asset.kind = 'THUMBNAIL')
        GROUP BY video.id, channel.id, search_query.value
      )
      SELECT * FROM ranked
      WHERE TRUE ${cursorClause}
      ORDER BY rank DESC, "publishedAt" DESC, id DESC
      LIMIT ${limit + 1}
    `);
    const parsed = z.array(rawVideoSchema).parse(rows);
    const hasMore = parsed.length > limit;
    const selected = parsed.slice(0, limit);
    const data = selected.map((row) => this.toCard(row));
    const last = selected.at(-1);
    this.logger.log({
      event: 'search.completed',
      queryLength: query.length,
      resultCount: data.length,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
    return {
      data,
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({
                asOf: asOf.toISOString(),
                rank: last.rank,
                publishedAt: last.publishedAt.toISOString(),
                id: last.id,
              })
            : null,
      },
    };
  }

  async related(
    videoId: string,
    userId: string | undefined,
    limit: number,
  ): Promise<VideoCardDto[]> {
    await this.videos.assertWatchAccess(videoId, userId);
    const current = await this.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      select: { title: true, channelId: true },
    });
    const rows = await this.prisma.$queryRaw<unknown[]>(Prisma.sql`
      WITH related_query AS (
        SELECT plainto_tsquery('english', ${current.title}) AS value
      )
      SELECT
        video.id,
        video.title,
        video."durationSeconds",
        video."publishedAt",
        COUNT(view_record.id)::int AS "viewsCount",
        channel.id AS "channelId",
        channel.name AS "channelName",
        channel.handle AS "channelHandle",
        channel."avatarUrl" AS "channelAvatarUrl",
        ROUND((
          CASE WHEN video."channelId" = ${current.channelId}::uuid THEN 100 ELSE 0 END
          + ts_rank_cd(video."searchVector", related_query.value) * 50
          + LEAST(LN(1 + COUNT(view_record.id)), 10) * 2
          + GREATEST(0, 2 - EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - video."publishedAt")) / 2592000)
        )::numeric, 6)::double precision AS rank
      FROM "Video" AS video
      JOIN "Channel" AS channel ON channel.id = video."channelId"
      CROSS JOIN related_query
      LEFT JOIN "VideoView" AS view_record ON view_record."videoId" = video.id
      WHERE video.id <> ${videoId}::uuid
        AND video.status = 'READY'
        AND video.visibility = 'PUBLIC'
        AND video."publishedAt" IS NOT NULL
        AND video."durationSeconds" IS NOT NULL
        AND (video."channelId" = ${current.channelId}::uuid OR video."searchVector" @@ related_query.value)
        AND EXISTS (SELECT 1 FROM "VideoAsset" asset WHERE asset."videoId" = video.id AND asset.kind = 'HLS_MANIFEST')
        AND EXISTS (SELECT 1 FROM "VideoAsset" asset WHERE asset."videoId" = video.id AND asset.kind = 'THUMBNAIL')
      GROUP BY video.id, channel.id, related_query.value
      ORDER BY rank DESC, video."publishedAt" DESC, video.id DESC
      LIMIT ${limit}
    `);
    return z
      .array(rawVideoSchema)
      .parse(rows)
      .map((row) => this.toCard(row));
  }

  private toCard(row: RawVideo): VideoCardDto {
    return {
      id: row.id,
      title: row.title,
      durationSeconds: row.durationSeconds,
      thumbnailUrl: `/api/v1/media/videos/${row.id}/thumbnail`,
      viewsCount: row.viewsCount,
      publishedAt: row.publishedAt.toISOString(),
      channel: {
        id: row.channelId,
        name: row.channelName,
        handle: row.channelHandle,
        avatarUrl: row.channelAvatarUrl,
      },
    };
  }
}

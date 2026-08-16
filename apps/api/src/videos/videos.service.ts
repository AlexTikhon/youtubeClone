import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  OwnerVideoDto,
  VideoCardDto,
  WatchVideoDto,
} from '@youtube-clone/types';
import type {
  CreateVideoInput,
  UpdateVideoInput,
} from '@youtube-clone/validation';
import type { ApiEnvironment } from '@youtube-clone/config';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { API_ENVIRONMENT } from '../config/config.module.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { AppError } from '../infrastructure/http/app-error.js';
import { decodeCursor, encodeCursor } from '../infrastructure/http/cursor.js';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../infrastructure/storage/storage.port.js';
import { assertVideoTransition } from './domain/video-state-machine.js';

interface DateIdCursor {
  date: string;
  id: string;
}
const dateIdCursorSchema = z.object({
  date: z.string().datetime(),
  id: z.string().uuid(),
});

const OWNER_INCLUDE = {
  channel: { select: { name: true, handle: true } },
  assets: {
    where: { kind: { in: ['THUMBNAIL', 'HLS_MANIFEST'] } },
    select: { kind: true, objectKey: true },
  },
  _count: { select: { views: true, likes: true, comments: true } },
} satisfies Prisma.VideoInclude;
type OwnerVideoRecord = Prisma.VideoGetPayload<{
  include: typeof OWNER_INCLUDE;
}>;
interface CardVideoRecord {
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
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async create(
    ownerId: string,
    input: CreateVideoInput,
  ): Promise<OwnerVideoDto> {
    const channel = await this.prisma.channel.findUnique({
      where: { ownerId },
      select: { id: true },
    });
    if (!channel)
      throw new AppError('CHANNEL_NOT_FOUND', 'Channel was not found', 404);
    const video = await this.prisma.video.create({
      data: {
        channelId: channel.id,
        title: input.title,
        description: input.description,
        visibility: input.visibility,
      },
      include: OWNER_INCLUDE,
    });
    return this.toOwnerDto(video);
  }

  async findOwned(videoId: string, ownerId: string) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, channel: { ownerId } },
      include: { upload: true },
    });
    if (!video)
      throw new AppError('VIDEO_NOT_FOUND', 'Video was not found', 404);
    return video;
  }

  async getOwned(videoId: string, ownerId: string): Promise<OwnerVideoDto> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, channel: { ownerId } },
      include: OWNER_INCLUDE,
    });
    if (!video)
      throw new AppError('VIDEO_NOT_FOUND', 'Video was not found', 404);
    return this.toOwnerDto(video);
  }

  async retryProcessing(
    videoId: string,
    ownerId: string,
    correlationId: string,
  ): Promise<{
    videoId: string;
    status: 'PROCESSING';
    processingGeneration: number;
  }> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, channel: { ownerId } },
      include: {
        assets: { where: { kind: 'ORIGINAL' } },
      },
    });
    if (!video)
      throw new AppError('VIDEO_NOT_FOUND', 'Video was not found', 404);
    if (video.status !== 'FAILED') {
      throw new AppError(
        'VIDEO_PROCESSING_RETRY_NOT_ALLOWED',
        'Only failed video processing can be retried',
        409,
      );
    }
    if (video.assets.length !== 1) {
      throw new AppError(
        'VIDEO_ORIGINAL_MISSING',
        'The original video is no longer available for processing',
        409,
      );
    }
    const original = video.assets[0]!;
    if (
      original.sizeBytes === null ||
      original.sizeBytes <= 0n ||
      original.mimeType.trim().length === 0
    ) {
      throw new AppError(
        'VIDEO_ORIGINAL_INVALID',
        'The original video metadata is not valid for processing',
        409,
      );
    }
    let stored;
    try {
      stored = await this.storage.headObject(
        original.bucket,
        original.objectKey,
      );
    } catch {
      throw new AppError(
        'VIDEO_ORIGINAL_OBJECT_MISSING',
        'The original video object is no longer available',
        409,
      );
    }
    if (
      stored.sizeBytes === null ||
      stored.sizeBytes !== original.sizeBytes ||
      stored.contentType.toLowerCase() !== original.mimeType.toLowerCase()
    ) {
      throw new AppError(
        'VIDEO_ORIGINAL_INVALID',
        'The stored original no longer matches its verified metadata',
        409,
      );
    }

    assertVideoTransition(video.status, 'PROCESSING');
    const generation = video.processingGeneration + 1;
    await this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.video.updateMany({
        where: {
          id: video.id,
          status: 'FAILED',
          processingGeneration: video.processingGeneration,
        },
        data: {
          status: 'PROCESSING',
          processingGeneration: generation,
          processingStartedAt: null,
          processingFinishedAt: null,
          failureReason: null,
        },
      });
      if (claimed.count !== 1) {
        throw new AppError(
          'VIDEO_PROCESSING_RETRY_ALREADY_ACCEPTED',
          'A processing retry was already accepted',
          409,
        );
      }
      await transaction.processingOutbox.create({
        data: {
          videoId: video.id,
          generation,
          originalAssetId: original.id,
          correlationId,
        },
      });
    });
    this.logger.log({
      event: 'video.processing.retry_requested',
      videoId,
      generation,
      correlationId,
      ownerId,
    });
    return { videoId, status: 'PROCESSING', processingGeneration: generation };
  }

  async listOwned(ownerId: string, cursor: string | undefined, limit: number) {
    const after = cursor
      ? decodeCursor<DateIdCursor>(cursor, dateIdCursorSchema)
      : undefined;
    const videos = await this.prisma.video.findMany({
      where: {
        channel: { ownerId },
        ...(after
          ? {
              OR: [
                { createdAt: { lt: new Date(after.date) } },
                { createdAt: new Date(after.date), id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: OWNER_INCLUDE,
    });
    const hasMore = videos.length > limit;
    const data = videos.slice(0, limit).map((video) => this.toOwnerDto(video));
    const last = data.at(-1);
    return {
      data,
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor({ date: last.createdAt, id: last.id })
            : null,
      },
    };
  }

  async getWatch(videoId: string, userId?: string): Promise<WatchVideoDto> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        channel: { include: { _count: { select: { subscriptions: true } } } },
        assets: {
          where: { kind: 'HLS_MANIFEST' },
          select: { id: true, objectKey: true },
        },
        _count: { select: { likes: true, views: true, comments: true } },
        ...(userId
          ? {
              likes: { where: { userId }, select: { userId: true } },
              watchHistory: {
                where: { userId },
                select: { lastPositionSeconds: true },
              },
            }
          : {}),
      },
    });
    const owned = video?.channel.ownerId === userId;
    const visible =
      video?.status === 'READY' &&
      (owned ||
        video.visibility === 'PUBLIC' ||
        video.visibility === 'UNLISTED');
    if (
      !video ||
      !visible ||
      video.assets.length === 0 ||
      video.durationSeconds === null
    )
      throw new AppError('VIDEO_NOT_FOUND', 'Video was not found', 404);
    const subscribed = userId
      ? await this.prisma.subscription.findUnique({
          where: {
            subscriberId_channelId: {
              subscriberId: userId,
              channelId: video.channelId,
            },
          },
          select: { subscriberId: true },
        })
      : null;
    const history = 'watchHistory' in video ? video.watchHistory[0] : undefined;
    const position = history?.lastPositionSeconds;
    return {
      id: video.id,
      title: video.title,
      visibility: video.visibility,
      description: video.description,
      durationSeconds: video.durationSeconds,
      playbackUrl: playbackUrlForManifest(video.id, video.assets[0]!.objectKey),
      publishedAt: video.publishedAt?.toISOString() ?? null,
      viewsCount: video._count.views,
      likesCount: video._count.likes,
      commentsCount: video._count.comments,
      likedByCurrentUser: 'likes' in video && video.likes.length > 0,
      channel: {
        id: video.channel.id,
        handle: video.channel.handle,
        name: video.channel.name,
        avatarUrl: video.channel.avatarUrl,
        subscribersCount: video.channel._count.subscriptions,
        subscribedByCurrentUser: Boolean(subscribed),
      },
      resumePositionSeconds:
        position !== undefined &&
        position > 5 &&
        position < video.durationSeconds - 10
          ? position
          : null,
    };
  }

  async update(
    videoId: string,
    ownerId: string,
    input: UpdateVideoInput,
  ): Promise<OwnerVideoDto> {
    const current = await this.findOwned(videoId, ownerId);
    if (current.status === 'DELETING')
      throw new AppError('VIDEO_STATE_CONFLICT', 'Video is being deleted', 409);
    const nextVisibility = input.visibility ?? current.visibility;
    const publishedAt =
      current.status === 'READY' && nextVisibility === 'PUBLIC'
        ? (current.publishedAt ?? new Date())
        : current.publishedAt;
    const video = await this.prisma.video.update({
      where: { id: videoId },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.visibility === undefined
          ? {}
          : { visibility: input.visibility, publishedAt }),
      },
      include: OWNER_INCLUDE,
    });
    if (
      input.visibility === 'PUBLIC' &&
      video.status === 'READY' &&
      video.publishedAt === null
    ) {
      const published = await this.prisma.video.update({
        where: { id: videoId },
        data: { publishedAt: new Date() },
        include: OWNER_INCLUDE,
      });
      return this.toOwnerDto(published);
    }
    return this.toOwnerDto(video);
  }

  async delete(videoId: string, ownerId: string): Promise<{ deleted: true }> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, channel: { ownerId } },
      include: {
        assets: {
          where: { kind: 'ORIGINAL' },
          select: { bucket: true, objectKey: true },
        },
        upload: { select: { bucket: true, objectKey: true } },
      },
    });
    if (!video)
      throw new AppError('VIDEO_NOT_FOUND', 'Video was not found', 404);
    if (video.status !== 'DELETING') {
      assertVideoTransition(video.status, 'DELETING');
      const claimed = await this.prisma.video.updateMany({
        where: { id: video.id, status: video.status },
        data: { status: 'DELETING' },
      });
      if (claimed.count !== 1)
        throw new AppError('VIDEO_STATE_CONFLICT', 'Video state changed', 409);
    }
    try {
      const originals = new Map<
        string,
        { bucket: string; objectKey: string }
      >();
      for (const object of [
        ...video.assets,
        ...(video.upload ? [video.upload] : []),
      ])
        originals.set(`${object.bucket}/${object.objectKey}`, object);
      await Promise.all([
        ...[...originals.values()].map((object) =>
          this.storage.deleteObject(object.bucket, object.objectKey),
        ),
        this.storage.deletePrefix(
          this.environment.S3_BUCKET_STREAMS,
          `videos/${video.id}/`,
        ),
        this.storage.deletePrefix(
          this.environment.S3_BUCKET_THUMBNAILS,
          `videos/${video.id}/`,
        ),
      ]);
      await this.prisma.video.delete({ where: { id: video.id } });
      this.logger.log({ event: 'video.deleted', videoId, ownerId });
      return { deleted: true };
    } catch (error) {
      this.logger.error({
        event: 'video.deletion.cleanup_failed',
        videoId,
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(
        'VIDEO_DELETE_FAILED',
        'Deletion is pending because media cleanup failed. Retry the deletion.',
        503,
      );
    }
  }

  async listPublic(cursor: string | undefined, limit: number) {
    const after = cursor
      ? decodeCursor<DateIdCursor>(cursor, dateIdCursorSchema)
      : undefined;
    const videos = await this.prisma.video.findMany({
      where: {
        status: 'READY',
        visibility: 'PUBLIC',
        publishedAt: { not: null },
        durationSeconds: { not: null },
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
    const hasMore = videos.length > limit;
    const data = videos.slice(0, limit).map((video) => this.toCardDto(video));
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

  async assertWatchAccess(videoId: string, userId?: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        id: true,
        status: true,
        visibility: true,
        durationSeconds: true,
        channel: { select: { ownerId: true } },
      },
    });
    const canView =
      video?.status === 'READY' &&
      (video.channel.ownerId === userId ||
        video.visibility === 'PUBLIC' ||
        video.visibility === 'UNLISTED');
    if (!video || !canView)
      throw new AppError('VIDEO_NOT_FOUND', 'Video was not found', 404);
    return video;
  }

  async assertMediaAccess(videoId: string, ownerId?: string) {
    return this.assertWatchAccess(videoId, ownerId);
  }

  async resolveMediaAsset(
    videoId: string,
    ownerId: string | undefined,
    kind: 'THUMBNAIL' | 'HLS_MANIFEST',
  ) {
    const access = await this.assertMediaAccess(videoId, ownerId);
    const asset = await this.prisma.videoAsset.findFirst({
      where: { videoId, kind },
      select: { bucket: true, objectKey: true },
    });
    if (!asset)
      throw new AppError('MEDIA_NOT_FOUND', 'Media was not found', 404);
    return { ...asset, visibility: access.visibility };
  }

  private toOwnerDto(video: OwnerVideoRecord): OwnerVideoDto {
    return {
      id: video.id,
      title: video.title,
      description: video.description,
      status: video.status,
      visibility: video.visibility,
      durationSeconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      failureReason: video.failureReason,
      processingGeneration: video.processingGeneration,
      processingStartedAt: video.processingStartedAt?.toISOString() ?? null,
      processingFinishedAt: video.processingFinishedAt?.toISOString() ?? null,
      updatedAt: video.updatedAt.toISOString(),
      channel: video.channel,
      thumbnailUrl: video.assets.some(
        (asset: { kind: string }) => asset.kind === 'THUMBNAIL',
      )
        ? `/api/v1/media/videos/${video.id}/thumbnail`
        : null,
      playbackUrl: video.assets.some(
        (asset: { kind: string }) => asset.kind === 'HLS_MANIFEST',
      )
        ? playbackUrlForManifest(
            video.id,
            video.assets.find(
              (asset: { kind: string }) => asset.kind === 'HLS_MANIFEST',
            )!.objectKey,
          )
        : null,
      publishedAt: video.publishedAt?.toISOString() ?? null,
      createdAt: video.createdAt.toISOString(),
      viewsCount: video._count.views,
      likesCount: video._count.likes,
      commentsCount: video._count.comments,
    };
  }

  toCardDto(video: CardVideoRecord): VideoCardDto {
    if (video.durationSeconds === null || video.publishedAt === null)
      throw new Error('Card read model requires published duration metadata');
    return {
      id: video.id,
      title: video.title,
      durationSeconds: video.durationSeconds,
      thumbnailUrl: `/api/v1/media/videos/${video.id}/thumbnail`,
      viewsCount: video._count.views,
      channel: video.channel,
      publishedAt: video.publishedAt.toISOString(),
    };
  }
}

function playbackUrlForManifest(videoId: string, objectKey: string): string {
  const isAbrMaster = objectKey.endsWith('/master.m3u8');
  return `/api/v1/media/videos/${videoId}/hls/${isAbrMaster ? 'master.m3u8' : '720p/index.m3u8'}`;
}

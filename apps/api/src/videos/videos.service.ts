import { Inject, Injectable } from '@nestjs/common';
import type { PublicVideoSummary, VideoSummary } from '@youtube-clone/types';
import type { CreateVideoInput } from '@youtube-clone/validation';

import { AppError } from '../infrastructure/http/app-error.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';

@Injectable()
export class VideosService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(ownerId: string, input: CreateVideoInput) {
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
      include: { channel: { select: { name: true, handle: true } } },
    });
    return this.toSummary(video, []);
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

  async getVisible(videoId: string, ownerId?: string): Promise<VideoSummary> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        channel: { select: { name: true, handle: true, ownerId: true } },
        assets: {
          where: { kind: { in: ['THUMBNAIL', 'HLS_MANIFEST'] } },
          select: { kind: true },
        },
      },
    });
    const owned = video?.channel.ownerId === ownerId;
    const externallyVisible =
      video?.status === 'READY' &&
      (video.visibility === 'PUBLIC' || video.visibility === 'UNLISTED');
    if (!video || (!owned && !externallyVisible))
      throw new AppError('VIDEO_NOT_FOUND', 'Video was not found', 404);
    return this.toSummary(video, video.assets);
  }

  async listPublic(): Promise<PublicVideoSummary[]> {
    const videos = await this.prisma.video.findMany({
      where: {
        status: 'READY',
        visibility: 'PUBLIC',
        publishedAt: { not: null },
        durationSeconds: { not: null },
        assets: { some: { kind: 'HLS_MANIFEST' } },
        AND: { assets: { some: { kind: 'THUMBNAIL' } } },
      },
      orderBy: { publishedAt: 'desc' },
      take: 50,
      include: { channel: { select: { name: true, handle: true } } },
    });
    return videos.map((video) => ({
      id: video.id,
      title: video.title,
      durationSeconds: video.durationSeconds!,
      thumbnailUrl: this.thumbnailUrl(video.id),
      channel: video.channel,
      publishedAt: video.publishedAt!.toISOString(),
    }));
  }

  async assertMediaAccess(videoId: string, ownerId?: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        status: true,
        visibility: true,
        channel: { select: { ownerId: true } },
      },
    });
    const canView =
      video?.status === 'READY' &&
      (video.channel.ownerId === ownerId ||
        video.visibility === 'PUBLIC' ||
        video.visibility === 'UNLISTED');
    if (!canView)
      throw new AppError('MEDIA_NOT_FOUND', 'Media was not found', 404);
  }

  private toSummary(
    video: {
      id: string;
      title: string;
      description: string | null;
      status: VideoSummary['status'];
      visibility: VideoSummary['visibility'];
      durationSeconds: number | null;
      width: number | null;
      height: number | null;
      failureReason: string | null;
      publishedAt: Date | null;
      createdAt: Date;
      channel: { name: string; handle: string };
    },
    assets: { kind: string }[],
  ): VideoSummary {
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
      channel: video.channel,
      thumbnailUrl: assets.some((asset) => asset.kind === 'THUMBNAIL')
        ? this.thumbnailUrl(video.id)
        : null,
      playbackUrl: assets.some((asset) => asset.kind === 'HLS_MANIFEST')
        ? `/api/v1/media/videos/${video.id}/hls/720p/index.m3u8`
        : null,
      publishedAt: video.publishedAt?.toISOString() ?? null,
      createdAt: video.createdAt.toISOString(),
    };
  }

  private thumbnailUrl(videoId: string): string {
    return `/api/v1/media/videos/${videoId}/thumbnail`;
  }
}

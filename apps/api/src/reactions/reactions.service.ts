import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LikeStateDto } from '@youtube-clone/types';

import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { VideosService } from '../videos/videos.service.js';

@Injectable()
export class ReactionsService {
  private readonly logger = new Logger(ReactionsService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideosService) private readonly videos: VideosService,
  ) {}

  async like(videoId: string, userId: string): Promise<LikeStateDto> {
    await this.videos.assertWatchAccess(videoId, userId);
    await this.prisma.videoLike.upsert({
      where: { userId_videoId: { userId, videoId } },
      create: { userId, videoId },
      update: {},
    });
    const likesCount = await this.prisma.videoLike.count({
      where: { videoId },
    });
    this.logger.log({ event: 'video.liked', videoId, userId });
    return { liked: true, likesCount };
  }

  async unlike(videoId: string, userId: string): Promise<LikeStateDto> {
    await this.videos.assertWatchAccess(videoId, userId);
    await this.prisma.videoLike.deleteMany({ where: { userId, videoId } });
    const likesCount = await this.prisma.videoLike.count({
      where: { videoId },
    });
    return { liked: false, likesCount };
  }
}

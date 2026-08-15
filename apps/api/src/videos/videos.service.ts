import { Inject, Injectable } from '@nestjs/common';
import type { CreateVideoInput } from '@youtube-clone/validation';

import { AppError } from '../infrastructure/http/app-error.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';

@Injectable()
export class VideosService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(ownerId: string, input: CreateVideoInput) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: input.channelId, ownerId },
      select: { id: true },
    });
    if (!channel)
      throw new AppError('CHANNEL_NOT_FOUND', 'Channel was not found', 404);
    return this.prisma.video.create({
      data: {
        channelId: channel.id,
        title: input.title,
        description: input.description,
        visibility: input.visibility,
      },
    });
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
}

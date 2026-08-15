import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChannelDto, SubscriptionStateDto } from '@youtube-clone/types';

import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { AppError } from '../infrastructure/http/app-error.js';
import { decodeCursor, encodeCursor } from '../infrastructure/http/cursor.js';
import { VideosService } from '../videos/videos.service.js';

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideosService) private readonly videos: VideosService,
  ) {}

  async get(handleInput: string, userId?: string): Promise<ChannelDto> {
    const handle = handleInput.replace(/^@/, '');
    const channel = await this.prisma.channel.findUnique({
      where: { handle },
      include: { _count: { select: { subscriptions: true } } },
    });
    if (!channel)
      throw new AppError('CHANNEL_NOT_FOUND', 'Channel was not found', 404);
    const subscription = userId
      ? await this.prisma.subscription.findUnique({
          where: {
            subscriberId_channelId: {
              subscriberId: userId,
              channelId: channel.id,
            },
          },
          select: { subscriberId: true },
        })
      : null;
    return {
      id: channel.id,
      handle: channel.handle,
      name: channel.name,
      description: channel.description,
      avatarUrl: channel.avatarUrl,
      subscribersCount: channel._count.subscriptions,
      subscribedByCurrentUser: Boolean(subscription),
      ownedByCurrentUser: channel.ownerId === userId,
    };
  }

  async videosForChannel(
    handleInput: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const handle = handleInput.replace(/^@/, '');
    const channel = await this.prisma.channel.findUnique({
      where: { handle },
      select: { id: true },
    });
    if (!channel)
      throw new AppError('CHANNEL_NOT_FOUND', 'Channel was not found', 404);
    return this.listDirect(channel.id, cursor, limit);
  }

  private async listDirect(
    channelId: string,
    cursor: string | undefined,
    limit: number,
  ) {
    const after = cursor
      ? decodeCursor<{ date: string; id: string }>(cursor)
      : undefined;
    const rows = await this.prisma.video.findMany({
      where: {
        channelId,
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

  async subscribe(
    channelId: string,
    userId: string,
  ): Promise<SubscriptionStateDto> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { ownerId: true },
    });
    if (!channel)
      throw new AppError('CHANNEL_NOT_FOUND', 'Channel was not found', 404);
    if (channel.ownerId === userId)
      throw new AppError(
        'SELF_SUBSCRIPTION',
        'You cannot subscribe to your own channel',
        409,
      );
    await this.prisma.subscription.upsert({
      where: { subscriberId_channelId: { subscriberId: userId, channelId } },
      create: { subscriberId: userId, channelId },
      update: {},
    });
    const subscriberCount = await this.prisma.subscription.count({
      where: { channelId },
    });
    this.logger.log({
      event: 'channel.subscribed',
      channelId,
      subscriberId: userId,
    });
    return { subscribed: true, subscriberCount };
  }

  async unsubscribe(
    channelId: string,
    userId: string,
  ): Promise<SubscriptionStateDto> {
    await this.prisma.subscription.deleteMany({
      where: { subscriberId: userId, channelId },
    });
    const subscriberCount = await this.prisma.subscription.count({
      where: { channelId },
    });
    return { subscribed: false, subscriberCount };
  }
}

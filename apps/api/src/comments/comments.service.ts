import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CommentDto } from '@youtube-clone/types';
import type { CreateCommentInput } from '@youtube-clone/validation';

import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { AppError } from '../infrastructure/http/app-error.js';
import { decodeCursor, encodeCursor } from '../infrastructure/http/cursor.js';
import { VideosService } from '../videos/videos.service.js';

interface CommentCursor {
  date: string;
  id: string;
}

@Injectable()
export class CommentsService {
  private readonly logger = new Logger(CommentsService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideosService) private readonly videos: VideosService,
  ) {}

  async list(
    videoId: string,
    userId: string | undefined,
    cursor: string | undefined,
    limit: number,
  ) {
    const video = await this.videos.assertWatchAccess(videoId, userId);
    const after = cursor ? decodeCursor<CommentCursor>(cursor) : undefined;
    const comments = await this.prisma.comment.findMany({
      where: {
        videoId,
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
      include: {
        author: { select: { id: true, username: true, avatarUrl: true } },
      },
    });
    const hasMore = comments.length > limit;
    const data = comments
      .slice(0, limit)
      .map((comment) => this.toDto(comment, userId, video.channel.ownerId));
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

  async create(
    videoId: string,
    userId: string,
    input: CreateCommentInput,
  ): Promise<CommentDto> {
    const video = await this.videos.assertWatchAccess(videoId, userId);
    const comment = await this.prisma.comment.create({
      data: { videoId, authorId: userId, content: input.content },
      include: {
        author: { select: { id: true, username: true, avatarUrl: true } },
      },
    });
    this.logger.log({
      event: 'comment.created',
      commentId: comment.id,
      videoId,
      authorId: userId,
    });
    return this.toDto(comment, userId, video.channel.ownerId);
  }

  async delete(commentId: string, userId: string): Promise<{ deleted: true }> {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        authorId: true,
        video: { select: { channel: { select: { ownerId: true } } } },
      },
    });
    if (!comment)
      throw new AppError('COMMENT_NOT_FOUND', 'Comment was not found', 404);
    if (comment.authorId !== userId && comment.video.channel.ownerId !== userId)
      throw new AppError(
        'COMMENT_FORBIDDEN',
        'You cannot delete this comment',
        403,
      );
    await this.prisma.comment.delete({ where: { id: commentId } });
    return { deleted: true };
  }

  private toDto(
    comment: {
      id: string;
      content: string;
      createdAt: Date;
      updatedAt: Date;
      authorId: string;
      author: { id: string; username: string; avatarUrl: string | null };
    },
    userId?: string,
    ownerId?: string,
  ): CommentDto {
    return {
      id: comment.id,
      content: comment.content,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      author: comment.author,
      canDelete: Boolean(
        userId && (comment.authorId === userId || ownerId === userId),
      ),
    };
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  createCommentSchema,
  cursorPaginationSchema,
  type CreateCommentInput,
  type CursorPaginationInput,
} from '@youtube-clone/validation';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { OptionalSessionGuard } from '../auth/optional-session.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { ZodBodyPipe } from '../infrastructure/http/zod-body.pipe.js';
import { RateLimit } from '../infrastructure/http/rate-limit.decorator.js';
import { RateLimitGuard } from '../infrastructure/http/rate-limit.guard.js';
import { CommentsService } from './comments.service.js';

@Controller()
export class CommentsController {
  constructor(
    @Inject(CommentsService) private readonly comments: CommentsService,
  ) {}
  @Get('videos/:videoId/comments')
  @UseGuards(OptionalSessionGuard)
  list(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Req() request: RequestWithContext,
    @Query(new ZodBodyPipe(cursorPaginationSchema))
    query: CursorPaginationInput,
  ) {
    return this.comments.list(
      videoId,
      request.user?.id,
      query.cursor,
      query.limit,
    );
  }
  @Post('videos/:videoId/comments')
  @UseGuards(SessionGuard, RateLimitGuard)
  @RateLimit({ scope: 'comments', limit: 20, windowSeconds: 60 })
  create(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(createCommentSchema)) input: CreateCommentInput,
  ) {
    return this.comments.create(videoId, user.id, input);
  }
  @Delete('comments/:commentId')
  @UseGuards(SessionGuard)
  delete(
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.comments.delete(commentId, user.id);
  }
}

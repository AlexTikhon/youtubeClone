import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import {
  cursorPaginationSchema,
  type CursorPaginationInput,
} from '@youtube-clone/validation';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { OptionalSessionGuard } from '../auth/optional-session.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { ZodBodyPipe } from '../infrastructure/http/zod-body.pipe.js';
import { VideosService } from '../videos/videos.service.js';
import { FeedsService } from './feeds.service.js';

@Controller()
export class FeedsController {
  constructor(
    @Inject(FeedsService) private readonly feeds: FeedsService,
    @Inject(VideosService) private readonly videos: VideosService,
  ) {}
  @Get('feeds/home')
  @UseGuards(OptionalSessionGuard)
  home(
    @Req() request: RequestWithContext,
    @Query(new ZodBodyPipe(cursorPaginationSchema))
    query: CursorPaginationInput,
  ) {
    return this.feeds.home(request.user?.id, query.cursor, query.limit);
  }
  @Get('feeds/subscriptions')
  @UseGuards(SessionGuard)
  subscriptions(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodBodyPipe(cursorPaginationSchema))
    query: CursorPaginationInput,
  ) {
    return this.feeds.subscriptions(user.id, query.cursor, query.limit);
  }
  @Get('studio/videos')
  @UseGuards(SessionGuard)
  studio(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodBodyPipe(cursorPaginationSchema))
    query: CursorPaginationInput,
  ) {
    return this.videos.listOwned(user.id, query.cursor, query.limit);
  }
}

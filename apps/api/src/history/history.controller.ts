import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  cursorPaginationSchema,
  recordViewSchema,
  updateHistorySchema,
  type CursorPaginationInput,
  type RecordViewInput,
  type UpdateHistoryInput,
} from '@youtube-clone/validation';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ZodBodyPipe } from '../infrastructure/http/zod-body.pipe.js';
import { RateLimit } from '../infrastructure/http/rate-limit.decorator.js';
import { RateLimitGuard } from '../infrastructure/http/rate-limit.guard.js';
import { HistoryService } from './history.service.js';

@Controller()
@UseGuards(SessionGuard)
export class HistoryController {
  constructor(
    @Inject(HistoryService) private readonly history: HistoryService,
  ) {}
  @Post('videos/:videoId/view')
  @UseGuards(RateLimitGuard)
  @RateLimit({ scope: 'view', limit: 30, windowSeconds: 60 })
  view(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(recordViewSchema)) input: RecordViewInput,
  ) {
    return this.history.recordView(videoId, user.id, input.watchedSeconds);
  }
  @Put('videos/:videoId/history')
  update(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(updateHistorySchema)) input: UpdateHistoryInput,
  ) {
    return this.history.update(videoId, user.id, input.positionSeconds);
  }
  @Get('history')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodBodyPipe(cursorPaginationSchema))
    query: CursorPaginationInput,
  ) {
    return this.history.list(user.id, query.cursor, query.limit);
  }
  @Delete('history/:videoId')
  remove(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.history.remove(videoId, user.id);
  }
}

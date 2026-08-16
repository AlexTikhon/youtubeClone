import {
  Controller,
  Body,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Put,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  cursorPaginationSchema,
  updateChannelSchema,
  type CursorPaginationInput,
  type UpdateChannelInput,
} from '@youtube-clone/validation';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { OptionalSessionGuard } from '../auth/optional-session.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { ZodBodyPipe } from '../infrastructure/http/zod-body.pipe.js';
import { ChannelsService } from './channels.service.js';

@Controller('channels')
export class ChannelsController {
  constructor(
    @Inject(ChannelsService) private readonly channels: ChannelsService,
  ) {}
  @Get('mine/settings')
  @UseGuards(SessionGuard)
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.channels.getMine(user.id);
  }
  @Patch('mine/settings')
  @UseGuards(SessionGuard)
  updateMine(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(updateChannelSchema)) input: UpdateChannelInput,
  ) {
    return this.channels.updateMine(user.id, input);
  }
  @Get(':handle')
  @UseGuards(OptionalSessionGuard)
  get(@Param('handle') handle: string, @Req() request: RequestWithContext) {
    return this.channels.get(handle, request.user?.id);
  }
  @Get(':handle/videos')
  videos(
    @Param('handle') handle: string,
    @Query(new ZodBodyPipe(cursorPaginationSchema))
    query: CursorPaginationInput,
  ) {
    return this.channels.videosForChannel(handle, query.cursor, query.limit);
  }
  @Put(':channelId/subscription')
  @UseGuards(SessionGuard)
  subscribe(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.channels.subscribe(channelId, user.id);
  }
  @Delete(':channelId/subscription')
  @UseGuards(SessionGuard)
  unsubscribe(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.channels.unsubscribe(channelId, user.id);
  }
}

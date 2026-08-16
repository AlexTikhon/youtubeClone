import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createPlaylistSchema,
  playlistListQuerySchema,
  updatePlaylistSchema,
  type CreatePlaylistInput,
  type PlaylistListQueryInput,
  type UpdatePlaylistInput,
} from '@youtube-clone/validation';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { OptionalSessionGuard } from '../auth/optional-session.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { ZodBodyPipe } from '../infrastructure/http/zod-body.pipe.js';
import { PlaylistsService } from './playlists.service.js';

@ApiTags('playlists')
@Controller('playlists')
export class PlaylistsController {
  constructor(
    @Inject(PlaylistsService) private readonly playlists: PlaylistsService,
  ) {}

  @Post()
  @ApiCookieAuth('session')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Create a custom playlist' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(createPlaylistSchema)) input: CreatePlaylistInput,
  ) {
    return this.playlists.create(user.id, input);
  }

  @Get('mine')
  @ApiCookieAuth('session')
  @UseGuards(SessionGuard)
  mine(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodBodyPipe(playlistListQuerySchema))
    query: PlaylistListQueryInput,
  ) {
    return this.playlists.mine(
      user.id,
      query.cursor,
      query.limit,
      query.videoId,
    );
  }

  @Get(':playlistId')
  @UseGuards(OptionalSessionGuard)
  get(
    @Param('playlistId', ParseUUIDPipe) playlistId: string,
    @Req() request: RequestWithContext,
  ) {
    return this.playlists.get(playlistId, request.user?.id);
  }

  @Patch(':playlistId')
  @UseGuards(SessionGuard)
  update(
    @Param('playlistId', ParseUUIDPipe) playlistId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(updatePlaylistSchema)) input: UpdatePlaylistInput,
  ) {
    return this.playlists.update(playlistId, user.id, input);
  }

  @Delete(':playlistId')
  @UseGuards(SessionGuard)
  delete(
    @Param('playlistId', ParseUUIDPipe) playlistId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.playlists.delete(playlistId, user.id);
  }

  @Put(':playlistId/videos/:videoId')
  @UseGuards(SessionGuard)
  addVideo(
    @Param('playlistId', ParseUUIDPipe) playlistId: string,
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.playlists.addVideo(playlistId, videoId, user.id);
  }

  @Delete(':playlistId/videos/:videoId')
  @UseGuards(SessionGuard)
  removeVideo(
    @Param('playlistId', ParseUUIDPipe) playlistId: string,
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.playlists.removeVideo(playlistId, videoId, user.id);
  }
}

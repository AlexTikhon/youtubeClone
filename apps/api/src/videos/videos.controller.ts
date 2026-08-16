import {
  Body,
  Controller,
  Get,
  Delete,
  Patch,
  Query,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type {
  CreateVideoInput,
  CursorPaginationInput,
  UpdateVideoInput,
} from '@youtube-clone/validation';
import {
  createVideoSchema,
  cursorPaginationSchema,
  updateVideoSchema,
} from '@youtube-clone/validation';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { SessionGuard } from '../auth/session.guard.js';
import { OptionalSessionGuard } from '../auth/optional-session.guard.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { ZodBodyPipe } from '../infrastructure/http/zod-body.pipe.js';
import {
  startUploadSchema,
  type StartUploadInput,
} from '../uploads/upload.schemas.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { VideosService } from './videos.service.js';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    @Inject(VideosService) private readonly videos: VideosService,
    @Inject(UploadsService) private readonly uploads: UploadsService,
  ) {}

  @Post()
  @ApiCookieAuth('session')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Create a private video draft' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', maxLength: 120 },
        description: { type: 'string', maxLength: 5000 },
        visibility: { type: 'string', enum: ['PRIVATE', 'UNLISTED', 'PUBLIC'] },
      },
    },
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(createVideoSchema)) input: CreateVideoInput,
  ) {
    return this.videos.create(user.id, input);
  }

  @Post(':videoId/upload')
  @ApiCookieAuth('session')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Create a signed URL for the original video upload',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['fileName', 'contentType', 'sizeBytes'],
      properties: {
        fileName: { type: 'string' },
        contentType: { type: 'string', example: 'video/mp4' },
        sizeBytes: { type: 'integer', minimum: 1 },
      },
    },
  })
  startUpload(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(startUploadSchema)) input: StartUploadInput,
  ) {
    return this.uploads.start(videoId, user.id, input);
  }

  @Post(':videoId/upload/complete')
  @ApiCookieAuth('session')
  @UseGuards(SessionGuard)
  @ApiOperation({ summary: 'Verify an upload and enqueue video processing' })
  completeUpload(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithContext,
  ) {
    return this.uploads.complete(videoId, user.id, request.requestId);
  }

  @Post(':videoId/retry-processing')
  @ApiCookieAuth('session')
  @UseGuards(SessionGuard)
  @ApiOperation({
    summary: 'Retry failed video processing as a new generation',
  })
  retryProcessing(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithContext,
  ) {
    return this.videos.retryProcessing(videoId, user.id, request.requestId);
  }

  @Get()
  listPublic(
    @Query(new ZodBodyPipe(cursorPaginationSchema))
    query: CursorPaginationInput,
  ) {
    return this.videos.listPublic(query.cursor, query.limit);
  }

  @Get(':videoId')
  @UseGuards(OptionalSessionGuard)
  getOne(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Req() request: RequestWithContext,
  ) {
    return this.videos.getWatch(videoId, request.user?.id);
  }

  @Get(':videoId/owner')
  @UseGuards(SessionGuard)
  getOwned(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videos.getOwned(videoId, user.id);
  }

  @Patch(':videoId')
  @UseGuards(SessionGuard)
  update(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(updateVideoSchema)) input: UpdateVideoInput,
  ) {
    return this.videos.update(videoId, user.id, input);
  }

  @Delete(':videoId')
  @UseGuards(SessionGuard)
  delete(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.videos.delete(videoId, user.id);
  }
}

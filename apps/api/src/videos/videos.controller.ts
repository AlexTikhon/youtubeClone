import {
  Body,
  Controller,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { CreateVideoInput } from '@youtube-clone/validation';
import { createVideoSchema } from '@youtube-clone/validation';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { ZodBodyPipe } from '../infrastructure/http/zod-body.pipe.js';
import {
  startUploadSchema,
  type StartUploadInput,
} from '../uploads/upload.schemas.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { VideosService } from './videos.service.js';

@ApiTags('videos')
@ApiCookieAuth('session')
@UseGuards(SessionGuard)
@Controller('videos')
export class VideosController {
  constructor(
    @Inject(VideosService) private readonly videos: VideosService,
    @Inject(UploadsService) private readonly uploads: UploadsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a private video draft' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['channelId', 'title'],
      properties: {
        channelId: { type: 'string', format: 'uuid' },
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
  @ApiOperation({ summary: 'Verify an upload and enqueue video processing' })
  completeUpload(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithContext,
  ) {
    return this.uploads.complete(videoId, user.id, request.requestId);
  }
}

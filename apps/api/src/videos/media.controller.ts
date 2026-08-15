import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import type { ApiEnvironment } from '@youtube-clone/config';

import { OptionalSessionGuard } from '../auth/optional-session.guard.js';
import { API_ENVIRONMENT } from '../config/config.module.js';
import { AppError } from '../infrastructure/http/app-error.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../infrastructure/storage/storage.port.js';
import { VideosService } from './videos.service.js';

@Controller('media/videos')
@UseGuards(OptionalSessionGuard)
export class MediaController {
  constructor(
    @Inject(VideosService) private readonly videos: VideosService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  @Get(':videoId/thumbnail')
  thumbnail(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    return this.send(
      videoId,
      request.user?.id,
      this.environment.S3_BUCKET_THUMBNAILS,
      `videos/${videoId}/thumbnail/thumbnail.jpg`,
      response,
    );
  }

  @Get(':videoId/hls/:rendition/:fileName')
  hls(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Param('rendition') rendition: string,
    @Param('fileName') fileName: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    if (
      rendition !== '720p' ||
      !/^(index\.m3u8|segment\d{3,6}\.ts)$/.test(fileName)
    ) {
      throw new AppError('MEDIA_NOT_FOUND', 'Media was not found', 404);
    }
    return this.send(
      videoId,
      request.user?.id,
      this.environment.S3_BUCKET_STREAMS,
      `videos/${videoId}/hls/${rendition}/${fileName}`,
      response,
    );
  }

  private async send(
    videoId: string,
    ownerId: string | undefined,
    bucket: string,
    objectKey: string,
    response: Response,
  ): Promise<void> {
    await this.videos.assertMediaAccess(videoId, ownerId);
    try {
      const object = await this.storage.getObject(bucket, objectKey);
      response.setHeader('content-type', object.contentType);
      response.setHeader('cache-control', 'private, max-age=60');
      if (object.sizeBytes !== null)
        response.setHeader('content-length', object.sizeBytes);
      object.body.pipe(response);
    } catch {
      throw new AppError('MEDIA_NOT_FOUND', 'Media was not found', 404);
    }
  }
}

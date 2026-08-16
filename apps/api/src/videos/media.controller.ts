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
      'immutable',
      request,
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
      !/^(source|360p|480p|720p)$/.test(rendition) ||
      !/^(index\.m3u8|segment\d{3,6}\.ts)$/.test(fileName)
    ) {
      throw new AppError('MEDIA_NOT_FOUND', 'Media was not found', 404);
    }
    return this.send(
      videoId,
      request.user?.id,
      this.environment.S3_BUCKET_STREAMS,
      `videos/${videoId}/hls/${rendition}/${fileName}`,
      'immutable',
      request,
      response,
    );
  }

  @Get(':videoId/hls/master.m3u8')
  masterManifest(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    return this.send(
      videoId,
      request.user?.id,
      this.environment.S3_BUCKET_STREAMS,
      `videos/${videoId}/hls/master.m3u8`,
      'immutable',
      request,
      response,
    );
  }

  private async send(
    videoId: string,
    ownerId: string | undefined,
    bucket: string,
    objectKey: string,
    publicCache: 'immutable' | 'manifest',
    request: RequestWithContext,
    response: Response,
  ): Promise<void> {
    const access = await this.videos.assertMediaAccess(videoId, ownerId);
    try {
      const object = await this.storage.getObject(bucket, objectKey);
      response.setHeader('content-type', object.contentType);
      response.setHeader(
        'cache-control',
        access.visibility === 'PUBLIC'
          ? publicCache === 'immutable'
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=300'
          : 'private, no-store',
      );
      if (object.sizeBytes !== null)
        response.setHeader('content-length', object.sizeBytes);
      request.once('aborted', () => object.body.destroy());
      object.body.once('error', () => response.destroy());
      object.body.pipe(response);
    } catch {
      throw new AppError('MEDIA_NOT_FOUND', 'Media was not found', 404);
    }
  }
}

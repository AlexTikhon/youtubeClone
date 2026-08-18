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

import { OptionalSessionGuard } from '../auth/optional-session.guard.js';
import { AppError } from '../infrastructure/http/app-error.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import {
  OBJECT_STORAGE,
  ObjectNotFoundError,
  type ObjectStorage,
} from '../infrastructure/storage/storage.port.js';
import { VideosService } from './videos.service.js';

@Controller('media/videos')
@UseGuards(OptionalSessionGuard)
export class MediaController {
  constructor(
    @Inject(VideosService) private readonly videos: VideosService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Get(':videoId/thumbnail')
  thumbnail(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Req() request: RequestWithContext,
    @Res() response: Response,
  ) {
    return this.sendAsset(
      videoId,
      request.user?.id,
      'THUMBNAIL',
      undefined,
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
    return this.sendAsset(
      videoId,
      request.user?.id,
      'HLS_MANIFEST',
      `${rendition}/${fileName}`,
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
    return this.sendAsset(
      videoId,
      request.user?.id,
      'HLS_MANIFEST',
      undefined,
      request,
      response,
    );
  }

  private async sendAsset(
    videoId: string,
    ownerId: string | undefined,
    kind: 'THUMBNAIL' | 'HLS_MANIFEST',
    relativeKey: string | undefined,
    request: RequestWithContext,
    response: Response,
  ): Promise<void> {
    const asset = await this.videos.resolveMediaAsset(videoId, ownerId, kind);
    const objectKey = relativeKey
      ? `${manifestRoot(asset.objectKey)}${relativeKey}`
      : asset.objectKey;
    try {
      const object = await this.storage.getObject(asset.bucket, objectKey);
      response.setHeader('content-type', object.contentType);
      response.setHeader(
        'cache-control',
        asset.visibility === 'PUBLIC'
          ? 'public, max-age=0, must-revalidate'
          : 'private, no-store',
      );
      if (object.sizeBytes !== null)
        response.setHeader('content-length', object.sizeBytes);
      request.once('aborted', () => object.body.destroy());
      object.body.once('error', () => response.destroy());
      object.body.pipe(response);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw new AppError('MEDIA_NOT_FOUND', 'Media was not found', 404);
      }
      throw new AppError(
        'MEDIA_STORAGE_UNAVAILABLE',
        'Media storage is temporarily unavailable',
        503,
      );
    }
  }
}

function manifestRoot(objectKey: string): string {
  if (objectKey.endsWith('/master.m3u8'))
    return objectKey.slice(0, -'master.m3u8'.length);
  const hlsMarker = '/hls/';
  const hlsIndex = objectKey.indexOf(hlsMarker);
  return hlsIndex >= 0
    ? objectKey.slice(0, hlsIndex + hlsMarker.length)
    : objectKey.slice(0, objectKey.lastIndexOf('/') + 1);
}

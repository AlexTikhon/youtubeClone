import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { UploadStatus, VideoAssetKind } from '@prisma/client';

import type { ApiEnvironment } from '@youtube-clone/config';
import { API_ENVIRONMENT } from '../config/config.module.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { AppError } from '../infrastructure/http/app-error.js';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingQueue,
} from '../infrastructure/queue/video-processing-queue.port.js';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../infrastructure/storage/storage.port.js';
import { assertVideoTransition } from '../videos/domain/video-state-machine.js';
import { VideosService } from '../videos/videos.service.js';
import type { StartUploadInput } from './upload.schemas.js';

@Injectable()
export class UploadsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideosService) private readonly videos: VideosService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: VideoProcessingQueue,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async start(videoId: string, ownerId: string, input: StartUploadInput) {
    if (input.sizeBytes > this.environment.MAX_UPLOAD_SIZE_BYTES) {
      throw new AppError(
        'UPLOAD_TOO_LARGE',
        'The file exceeds the upload size limit',
        413,
      );
    }
    const video = await this.videos.findOwned(videoId, ownerId);
    if (
      video.status === 'UPLOADING' &&
      video.upload?.status === UploadStatus.PENDING
    ) {
      if (
        video.upload.contentType !== input.contentType ||
        video.upload.expectedSizeBytes !== BigInt(input.sizeBytes)
      ) {
        throw new AppError(
          'UPLOAD_INTENT_MISMATCH',
          'Retry the upload with the original content type and size',
          409,
        );
      }
      return this.createUploadResponse(
        video.upload.bucket,
        video.upload.objectKey,
        video.upload.contentType,
      );
    }
    if (video.status !== 'DRAFT') {
      throw new AppError(
        'VIDEO_STATE_CONFLICT',
        'Video is not ready to begin an upload',
        409,
      );
    }
    if (video.upload) {
      throw new AppError(
        'UPLOAD_ALREADY_STARTED',
        'An upload already exists',
        409,
      );
    }
    assertVideoTransition(video.status, 'UPLOADING');

    const extension = this.safeExtension(input.fileName);
    const objectKey = `originals/${video.id}/${randomUUID()}${extension}`;
    const bucket = this.environment.S3_BUCKET_ORIGINALS;

    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.video.updateMany({
        where: { id: video.id, status: 'DRAFT' },
        data: { status: 'UPLOADING' },
      });
      if (updated.count !== 1)
        throw new AppError('VIDEO_STATE_CONFLICT', 'Video state changed', 409);
      await transaction.videoUpload.create({
        data: {
          videoId: video.id,
          bucket,
          objectKey,
          contentType: input.contentType,
          expectedSizeBytes: BigInt(input.sizeBytes),
        },
      });
    });

    return this.createUploadResponse(bucket, objectKey, input.contentType);
  }

  private async createUploadResponse(
    bucket: string,
    objectKey: string,
    contentType: string,
  ) {
    const uploadUrl = await this.storage.createUploadUrl({
      bucket,
      objectKey,
      contentType,
      expiresInSeconds: 15 * 60,
    });
    return {
      uploadUrl,
      expiresInSeconds: 15 * 60,
      requiredHeaders: { 'content-type': contentType },
    };
  }

  async complete(videoId: string, ownerId: string, correlationId: string) {
    const video = await this.videos.findOwned(videoId, ownerId);
    if (!video.upload)
      throw new AppError(
        'UPLOAD_NOT_STARTED',
        'No upload exists for this video',
        409,
      );
    const upload = video.upload;
    if (video.status !== 'UPLOADING' && video.status !== 'UPLOADED') {
      throw new AppError(
        'VIDEO_STATE_CONFLICT',
        'Video is not awaiting upload completion',
        409,
      );
    }

    let metadata;
    try {
      metadata = await this.storage.headObject(upload.bucket, upload.objectKey);
    } catch {
      throw new AppError(
        'UPLOADED_OBJECT_NOT_FOUND',
        'The uploaded object is not available',
        409,
      );
    }
    if (metadata.sizeBytes === null || metadata.sizeBytes === 0n)
      throw new AppError(
        'UPLOADED_OBJECT_EMPTY',
        'The uploaded object is empty',
        409,
      );
    if (
      upload.expectedSizeBytes &&
      metadata.sizeBytes !== upload.expectedSizeBytes
    ) {
      throw new AppError(
        'UPLOAD_SIZE_MISMATCH',
        'Uploaded object size does not match the request',
        409,
      );
    }
    if (
      metadata.contentType.toLowerCase() !== upload.contentType.toLowerCase()
    ) {
      throw new AppError(
        'UPLOAD_CONTENT_TYPE_MISMATCH',
        'Uploaded object content type does not match the upload intent',
        409,
      );
    }

    const asset = await this.prisma.$transaction(async (transaction) => {
      if (video.status === 'UPLOADING') {
        assertVideoTransition(video.status, 'UPLOADED');
        const updated = await transaction.video.updateMany({
          where: { id: video.id, status: 'UPLOADING' },
          data: { status: 'UPLOADED' },
        });
        if (updated.count !== 1)
          throw new AppError(
            'VIDEO_STATE_CONFLICT',
            'Video state changed',
            409,
          );
        await transaction.videoUpload.update({
          where: { id: upload.id },
          data: { status: UploadStatus.COMPLETED, completedAt: new Date() },
        });
      }
      return transaction.videoAsset.upsert({
        where: {
          bucket_objectKey: {
            bucket: upload.bucket,
            objectKey: upload.objectKey,
          },
        },
        create: {
          videoId: video.id,
          kind: VideoAssetKind.ORIGINAL,
          bucket: upload.bucket,
          objectKey: upload.objectKey,
          mimeType: metadata.contentType,
          sizeBytes: metadata.sizeBytes,
        },
        update: {
          mimeType: metadata.contentType,
          sizeBytes: metadata.sizeBytes,
        },
      });
    });

    await this.processingQueue.enqueue({
      schemaVersion: 1,
      videoId: video.id,
      originalAssetId: asset.id,
      correlationId,
    });
    return { videoId: video.id, status: 'UPLOADED' as const };
  }

  private safeExtension(fileName: string): string {
    const match = /\.[a-z0-9]{1,10}$/i.exec(fileName);
    return match?.[0].toLowerCase() ?? '';
  }
}

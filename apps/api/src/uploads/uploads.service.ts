import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  UploadCompletionResponse,
  UploadIntentResponse,
} from '@youtube-clone/types';
import { UploadStatus, VideoAssetKind } from '@prisma/client';

import type { ApiEnvironment } from '@youtube-clone/config';
import { API_ENVIRONMENT } from '../config/config.module.js';
import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { AppError } from '../infrastructure/http/app-error.js';
import {
  OBJECT_STORAGE,
  ObjectNotFoundError,
  type ObjectStorage,
} from '../infrastructure/storage/storage.port.js';
import { assertVideoTransition } from '../videos/domain/video-state-machine.js';
import { VideosService } from '../videos/videos.service.js';
import type { StartUploadInput } from './upload.schemas.js';

const UPLOAD_POLICY_TTL_SECONDS = 15 * 60;

/** Internal signal: another call already moved this video past UPLOADING. */
class CompletionRaceLost extends Error {}

const ACCEPTED_STATUSES = [
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
] as const;

/**
 * The completed upload's current state, if completion was already accepted.
 * Requires the upload itself to be COMPLETED so that unrelated lifecycle states
 * (a failed or ready video whose upload never finished) are not mistaken for it.
 */
function acceptedCompletion(video: {
  id: string;
  status: string;
  processingGeneration: number;
  upload: { status: UploadStatus } | null;
}): UploadCompletionResponse | null {
  const status = ACCEPTED_STATUSES.find((value) => value === video.status);
  if (!status || video.upload?.status !== UploadStatus.COMPLETED) return null;
  return {
    videoId: video.id,
    status,
    processingGeneration: video.processingGeneration,
    alreadyCompleted: true,
  };
}

@Injectable()
export class UploadsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VideosService) private readonly videos: VideosService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
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
        video.upload.expectedSizeBytes,
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

    return this.createUploadResponse(
      bucket,
      objectKey,
      input.contentType,
      BigInt(input.sizeBytes),
    );
  }

  private async createUploadResponse(
    bucket: string,
    objectKey: string,
    contentType: string,
    sizeBytes: bigint | null,
  ): Promise<UploadIntentResponse> {
    if (sizeBytes === null || sizeBytes <= 0n) {
      throw new AppError(
        'UPLOAD_INTENT_MISMATCH',
        'This upload predates size enforcement; start a new upload',
        409,
      );
    }
    if (sizeBytes > BigInt(this.environment.MAX_UPLOAD_SIZE_BYTES)) {
      throw new AppError(
        'UPLOAD_TOO_LARGE',
        'The file exceeds the upload size limit',
        413,
      );
    }
    let policy;
    try {
      policy = await this.storage.createUploadPolicy({
        bucket,
        objectKey,
        contentType,
        sizeBytes,
        expiresInSeconds: UPLOAD_POLICY_TTL_SECONDS,
      });
    } catch {
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        'Object storage is temporarily unavailable',
        503,
      );
    }
    return {
      method: 'POST',
      uploadUrl: policy.url,
      fields: policy.fields,
      sizeBytes: Number(sizeBytes),
      expiresInSeconds: UPLOAD_POLICY_TTL_SECONDS,
    };
  }

  /**
   * Finalizes an upload. Idempotent: if this upload was already accepted, the
   * video's current lifecycle state is returned (the client may simply have lost
   * the first response). Concurrent first calls race on the UPLOADING ->
   * UPLOADED compare-and-set; the loser reports the winner's accepted state, so
   * exactly one ORIGINAL asset and one generation outbox event are created.
   */
  async complete(
    videoId: string,
    ownerId: string,
    correlationId: string,
  ): Promise<UploadCompletionResponse> {
    const video = await this.videos.findOwned(videoId, ownerId);
    if (!video.upload)
      throw new AppError(
        'UPLOAD_NOT_STARTED',
        'No upload exists for this video',
        409,
      );
    const upload = video.upload;
    const replay = acceptedCompletion(video);
    if (replay) return replay;
    if (video.status !== 'UPLOADING') {
      throw new AppError(
        'VIDEO_STATE_CONFLICT',
        'Video is not awaiting upload completion',
        409,
      );
    }

    let metadata;
    try {
      metadata = await this.storage.headObject(upload.bucket, upload.objectKey);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        throw new AppError(
          'UPLOADED_OBJECT_NOT_FOUND',
          'The uploaded object is not available',
          409,
        );
      }
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        'Object storage is temporarily unavailable',
        503,
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

    const generation = Math.max(1, video.processingGeneration);
    try {
      await this.prisma.$transaction(async (transaction) => {
        assertVideoTransition(video.status, 'UPLOADED');
        const updated = await transaction.video.updateMany({
          where: { id: video.id, status: 'UPLOADING' },
          data: {
            status: 'UPLOADED',
            processingGeneration: generation,
            processingStartedAt: null,
            processingFinishedAt: null,
            processingAttemptId: null,
            processingLeaseExpiresAt: null,
            failureReason: null,
          },
        });
        if (updated.count !== 1) throw new CompletionRaceLost();
        await transaction.videoUpload.update({
          where: { id: upload.id },
          data: { status: UploadStatus.COMPLETED, completedAt: new Date() },
        });
        const asset = await transaction.videoAsset.upsert({
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
        await transaction.processingOutbox.upsert({
          where: {
            videoId_generation: { videoId: video.id, generation },
          },
          create: {
            videoId: video.id,
            generation,
            originalAssetId: asset.id,
            correlationId,
          },
          update: {},
        });
      });
    } catch (error) {
      if (!(error instanceof CompletionRaceLost)) throw error;
      const current = await this.videos.findOwned(videoId, ownerId);
      const winner = acceptedCompletion(current);
      if (winner) return winner;
      throw new AppError('VIDEO_STATE_CONFLICT', 'Video state changed', 409);
    }
    return {
      videoId: video.id,
      status: 'UPLOADED',
      processingGeneration: generation,
      alreadyCompleted: false,
    };
  }

  private safeExtension(fileName: string): string {
    const match = /\.[a-z0-9]{1,10}$/i.exec(fileName);
    return match?.[0].toLowerCase() ?? '';
  }
}

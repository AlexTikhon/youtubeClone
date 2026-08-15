import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  assertVideoTransition,
  type ProcessVideoJob,
} from '@youtube-clone/types';

import { DatabaseService } from './database.service.js';
import { MediaToolsService } from './media-tools.service.js';
import { StorageService } from './storage.service.js';

@Injectable()
export class VideoProcessingPipeline {
  private readonly logger = new Logger(VideoProcessingPipeline.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(MediaToolsService) private readonly mediaTools: MediaToolsService,
  ) {}

  async execute(jobId: string, input: ProcessVideoJob): Promise<void> {
    const video = await this.database.video.findUnique({
      where: { id: input.videoId },
      include: {
        assets: { where: { id: input.originalAssetId, kind: 'ORIGINAL' } },
      },
    });
    if (!video) {
      this.logger.log({
        event: 'video.processing.deleted_skipped',
        videoId: input.videoId,
        jobId,
      });
      return;
    }
    if (video.status === 'DELETING') {
      this.logger.log({
        event: 'video.processing.deletion_skipped',
        videoId: input.videoId,
        jobId,
      });
      return;
    }
    if (video.assets.length !== 1)
      throw new Error('Original asset was not found');
    if (video.status === 'READY') {
      this.logger.log({
        event: 'video.processing.duplicate_skipped',
        videoId: input.videoId,
        jobId,
        correlationId: input.correlationId,
      });
      return;
    }
    if (video.status === 'UPLOADED') {
      assertVideoTransition(video.status, 'PROCESSING');
      const claimed = await this.database.video.updateMany({
        where: { id: video.id, status: 'UPLOADED' },
        data: { status: 'PROCESSING', failureReason: null },
      });
      if (claimed.count !== 1)
        throw new Error('Video processing claim was lost');
    } else if (video.status !== 'PROCESSING') {
      throw new Error(`Video is not processable from ${video.status}`);
    }

    const workDirectory = await mkdtemp(
      join(tmpdir(), `youtube-clone-${video.id}-`),
    );
    const originalPath = join(workDirectory, 'original');
    const thumbnailPath = join(workDirectory, 'thumbnail.jpg');
    const hlsDirectory = join(workDirectory, 'hls');
    try {
      const original = video.assets[0]!;
      await this.storage.download(
        original.bucket,
        original.objectKey,
        originalPath,
      );
      const metadata = await this.mediaTools.probe(originalPath);
      await this.mediaTools.generateThumbnail(
        originalPath,
        thumbnailPath,
        metadata,
      );
      const rendition = await this.mediaTools.generateHls(
        originalPath,
        hlsDirectory,
        metadata,
      );
      const stillProcessable = await this.database.video.count({
        where: { id: video.id, status: 'PROCESSING' },
      });
      if (stillProcessable !== 1) {
        this.logger.log({
          event: 'video.processing.cancelled_before_upload',
          videoId: input.videoId,
          jobId,
        });
        return;
      }
      const thumbnail = await this.storage.uploadThumbnail(
        video.id,
        thumbnailPath,
      );
      const hls = await this.storage.uploadHls(video.id, hlsDirectory);

      await this.database.$transaction(async (transaction) => {
        await transaction.videoAsset.update({
          where: { id: original.id },
          data: {
            width: metadata.width,
            height: metadata.height,
            bitrateKbps: metadata.bitrateKbps,
            durationSeconds: Math.round(metadata.durationSeconds),
            metadata: {
              container: metadata.container,
              videoCodec: metadata.videoCodec,
              audioCodec: metadata.audioCodec,
              frameRate: metadata.frameRate,
            },
          },
        });
        await transaction.videoAsset.upsert({
          where: {
            bucket_objectKey: {
              bucket: thumbnail.bucket,
              objectKey: thumbnail.objectKey,
            },
          },
          create: {
            videoId: video.id,
            kind: 'THUMBNAIL',
            bucket: thumbnail.bucket,
            objectKey: thumbnail.objectKey,
            mimeType: 'image/jpeg',
            sizeBytes: thumbnail.sizeBytes,
            width: rendition.width,
            height: rendition.height,
          },
          update: {
            sizeBytes: thumbnail.sizeBytes,
            width: rendition.width,
            height: rendition.height,
          },
        });
        const renditionMetadata = {
          renditions: [
            {
              name: '720p',
              storagePrefix: hls.storagePrefix,
              width: rendition.width,
              height: rendition.height,
              segmentCount: hls.segmentCount,
              videoCodec: 'h264',
              audioCodec: metadata.audioCodec ? 'aac' : null,
            },
          ],
        };
        await transaction.videoAsset.upsert({
          where: {
            bucket_objectKey: {
              bucket: hls.bucket,
              objectKey: hls.manifestKey,
            },
          },
          create: {
            videoId: video.id,
            kind: 'HLS_MANIFEST',
            bucket: hls.bucket,
            objectKey: hls.manifestKey,
            mimeType: 'application/vnd.apple.mpegurl',
            sizeBytes: hls.manifestSizeBytes,
            width: rendition.width,
            height: rendition.height,
            durationSeconds: Math.round(metadata.durationSeconds),
            metadata: renditionMetadata,
          },
          update: {
            sizeBytes: hls.manifestSizeBytes,
            width: rendition.width,
            height: rendition.height,
            durationSeconds: Math.round(metadata.durationSeconds),
            metadata: renditionMetadata,
          },
        });
        assertVideoTransition('PROCESSING', 'READY');
        const completed = await transaction.video.updateMany({
          where: { id: video.id, status: 'PROCESSING' },
          data: {
            status: 'READY',
            durationSeconds: Math.round(metadata.durationSeconds),
            width: metadata.width,
            height: metadata.height,
            failureReason: null,
            publishedAt:
              video.visibility === 'PUBLIC'
                ? (video.publishedAt ?? new Date())
                : null,
          },
        });
        if (completed.count !== 1)
          throw new Error('Video state changed before processing completion');
      });
      this.logger.log({
        event: 'video.processing.ready',
        videoId: input.videoId,
        jobId,
        correlationId: input.correlationId,
        durationSeconds: metadata.durationSeconds,
        width: rendition.width,
        height: rendition.height,
      });
    } catch (error) {
      const current = await this.database.video.findUnique({
        where: { id: video.id },
        select: { status: true },
      });
      if (!current || current.status === 'DELETING') {
        await this.storage.removeGenerated(video.id).catch(() => undefined);
        this.logger.log({
          event: 'video.processing.cancelled_after_upload',
          videoId: input.videoId,
          jobId,
        });
        return;
      }
      throw error;
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }

  async fail(videoId: string, publicReason: string): Promise<void> {
    try {
      await this.storage.removeGenerated(videoId);
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.cleanup_failed',
        videoId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    assertVideoTransition('PROCESSING', 'FAILED');
    await this.database.video.updateMany({
      where: { id: videoId, status: 'PROCESSING' },
      data: { status: 'FAILED', failureReason: publicReason.slice(0, 500) },
    });
  }
}

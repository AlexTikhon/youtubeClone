import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  assertVideoTransition,
  type ProcessVideoJob,
} from '@youtube-clone/types';

import { DatabaseService } from './database.service.js';
import { selectRenditions, type GeneratedRendition } from './hls-renditions.js';
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

  async execute(
    jobId: string,
    input: ProcessVideoJob,
    bullAttempt = 1,
  ): Promise<void> {
    const video = await this.database.video.findUnique({
      where: { id: input.videoId },
      include: {
        assets: { where: { id: input.originalAssetId, kind: 'ORIGINAL' } },
      },
    });
    if (!video) {
      this.logger.log({
        event: 'video.processing.cancelled',
        videoId: input.videoId,
        jobId,
        generation: input.generation,
        bullAttempt,
        correlationId: input.correlationId,
        reason: 'video_deleted',
      });
      return;
    }
    if (video.processingGeneration !== input.generation) {
      this.logger.log({
        event: 'video.processing.stale_job_skipped',
        videoId: input.videoId,
        jobId,
        generation: input.generation,
        currentGeneration: video.processingGeneration,
        bullAttempt,
        correlationId: input.correlationId,
      });
      return;
    }
    if (video.status === 'DELETING') {
      this.logger.log({
        event: 'video.processing.cancelled',
        videoId: input.videoId,
        jobId,
        generation: input.generation,
        bullAttempt,
        correlationId: input.correlationId,
        reason: 'deleting',
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
        generation: input.generation,
        bullAttempt,
        correlationId: input.correlationId,
      });
      return;
    }
    if (video.status === 'UPLOADED') {
      assertVideoTransition(video.status, 'PROCESSING');
      const claimed = await this.database.video.updateMany({
        where: {
          id: video.id,
          status: 'UPLOADED',
          processingGeneration: input.generation,
        },
        data: {
          status: 'PROCESSING',
          failureReason: null,
          processingStartedAt: new Date(),
          processingFinishedAt: null,
        },
      });
      if (claimed.count !== 1)
        throw new Error('Video processing claim was lost');
    } else if (video.status === 'PROCESSING') {
      await this.database.video.updateMany({
        where: {
          id: video.id,
          status: 'PROCESSING',
          processingGeneration: input.generation,
          processingStartedAt: null,
        },
        data: { processingStartedAt: new Date() },
      });
    } else {
      throw new Error(`Video is not processable from ${video.status}`);
    }

    this.logger.log({
      event: 'video.processing.started',
      videoId: input.videoId,
      jobId,
      generation: input.generation,
      bullAttempt,
      correlationId: input.correlationId,
    });

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
        original.sizeBytes,
      );
      const metadata = await this.mediaTools.probe(originalPath);
      const thumbnailSize = await this.mediaTools.generateThumbnail(
        originalPath,
        thumbnailPath,
        metadata,
      );
      const renditionSpecs = selectRenditions({
        sourceWidth: metadata.width,
        sourceHeight: metadata.height,
        hasAudio: metadata.audioCodec !== null,
      });
      const generatedRenditions: GeneratedRendition[] = [];
      for (const spec of renditionSpecs) {
        const startedAt = performance.now();
        this.logger.log({
          event: 'video.processing.rendition.started',
          videoId: input.videoId,
          jobId,
          generation: input.generation,
          bullAttempt,
          correlationId: input.correlationId,
          rendition: spec.name,
        });
        const generated = await this.mediaTools.generateHlsRendition(
          originalPath,
          hlsDirectory,
          spec,
        );
        generatedRenditions.push(generated);
        this.logger.log({
          event: 'video.processing.rendition.completed',
          videoId: input.videoId,
          jobId,
          generation: input.generation,
          bullAttempt,
          correlationId: input.correlationId,
          rendition: spec.name,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      const masterStartedAt = performance.now();
      await this.mediaTools.generateHlsMaster(
        hlsDirectory,
        generatedRenditions,
      );
      this.logger.log({
        event: 'video.processing.master.created',
        videoId: input.videoId,
        jobId,
        generation: input.generation,
        bullAttempt,
        correlationId: input.correlationId,
        renditionCount: generatedRenditions.length,
        durationMs: Math.round(performance.now() - masterStartedAt),
      });
      const stillProcessable = await this.database.video.count({
        where: {
          id: video.id,
          status: 'PROCESSING',
          processingGeneration: input.generation,
        },
      });
      if (stillProcessable !== 1) {
        this.logger.log({
          event: 'video.processing.cancelled',
          videoId: input.videoId,
          jobId,
          generation: input.generation,
          bullAttempt,
          correlationId: input.correlationId,
          reason: 'ownership_lost_before_upload',
        });
        return;
      }
      await this.storage.removeGenerated(video.id, input.generation);
      const thumbnail = await this.storage.uploadThumbnail(
        video.id,
        input.generation,
        thumbnailPath,
      );
      const hls = await this.storage.uploadHls(
        video.id,
        input.generation,
        hlsDirectory,
        renditionSpecs.map((spec) => spec.name),
      );

      const ownsBeforeCommit = await this.database.video.count({
        where: {
          id: video.id,
          status: 'PROCESSING',
          processingGeneration: input.generation,
        },
      });
      if (ownsBeforeCommit !== 1) {
        await this.storage.removeGenerated(video.id, input.generation);
        this.logger.log({
          event: 'video.processing.cancelled',
          videoId: input.videoId,
          jobId,
          generation: input.generation,
          bullAttempt,
          correlationId: input.correlationId,
          reason: 'ownership_lost_before_commit',
        });
        return;
      }

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
              rotationDegrees: metadata.rotationDegrees,
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
            width: thumbnailSize.width,
            height: thumbnailSize.height,
          },
          update: {
            sizeBytes: thumbnail.sizeBytes,
            width: thumbnailSize.width,
            height: thumbnailSize.height,
          },
        });
        const renditionMetadata = {
          segmentDurationSeconds: 6,
          renditions: generatedRenditions.map((generated) => {
            const stored = hls.renditions.find(
              (rendition) => rendition.name === generated.spec.name,
            );
            if (!stored)
              throw new Error(
                `Stored ${generated.spec.name} rendition metadata is missing`,
              );
            return {
              name: generated.spec.name,
              storagePrefix: stored.storagePrefix,
              manifestKey: stored.manifestKey,
              width: generated.spec.width,
              height: generated.spec.height,
              videoBitrateKbps: generated.spec.videoBitrateKbps,
              audioBitrateKbps: metadata.audioCodec
                ? generated.spec.audioBitrateKbps
                : null,
              bandwidthBitsPerSecond: generated.spec.bandwidthBitsPerSecond,
              segmentCount: stored.segmentCount,
              videoCodec: 'h264',
              audioCodec: metadata.audioCodec ? 'aac' : null,
            };
          }),
        };
        const largestRendition = renditionSpecs.at(-1)!;
        await transaction.videoAsset.upsert({
          where: {
            bucket_objectKey: {
              bucket: hls.bucket,
              objectKey: hls.masterManifestKey,
            },
          },
          create: {
            videoId: video.id,
            kind: 'HLS_MANIFEST',
            bucket: hls.bucket,
            objectKey: hls.masterManifestKey,
            mimeType: 'application/vnd.apple.mpegurl',
            sizeBytes: hls.masterManifestSizeBytes,
            width: largestRendition.width,
            height: largestRendition.height,
            durationSeconds: Math.round(metadata.durationSeconds),
            metadata: renditionMetadata,
          },
          update: {
            sizeBytes: hls.masterManifestSizeBytes,
            width: largestRendition.width,
            height: largestRendition.height,
            durationSeconds: Math.round(metadata.durationSeconds),
            metadata: renditionMetadata,
          },
        });
        assertVideoTransition('PROCESSING', 'READY');
        const completed = await transaction.video.updateMany({
          where: {
            id: video.id,
            status: 'PROCESSING',
            processingGeneration: input.generation,
          },
          data: {
            status: 'READY',
            durationSeconds: Math.round(metadata.durationSeconds),
            width: metadata.width,
            height: metadata.height,
            failureReason: null,
            processingFinishedAt: new Date(),
          },
        });
        if (completed.count !== 1)
          throw new Error('Video state changed before processing completion');
        await transaction.video.updateMany({
          where: {
            id: video.id,
            status: 'READY',
            visibility: 'PUBLIC',
            publishedAt: null,
          },
          data: { publishedAt: new Date() },
        });
      });
      try {
        await this.storage.removeObsoleteGenerated(video.id, input.generation);
      } catch (error) {
        this.logger.warn({
          event: 'video.processing.cleanup_failed',
          videoId: input.videoId,
          jobId,
          generation: input.generation,
          bullAttempt,
          correlationId: input.correlationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.logger.log({
        event: 'video.processing.ready',
        videoId: input.videoId,
        jobId,
        generation: input.generation,
        bullAttempt,
        correlationId: input.correlationId,
        durationSeconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        renditionCount: generatedRenditions.length,
      });
    } catch (error) {
      const current = await this.database.video.findUnique({
        where: { id: video.id },
        select: { status: true, processingGeneration: true },
      });
      if (
        !current ||
        current.status !== 'PROCESSING' ||
        current.processingGeneration !== input.generation
      ) {
        await this.storage
          .removeGenerated(video.id, input.generation)
          .catch((cleanupError: unknown) =>
            this.logger.warn({
              event: 'video.processing.cleanup_failed',
              videoId: input.videoId,
              jobId,
              generation: input.generation,
              bullAttempt,
              correlationId: input.correlationId,
              error:
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
            }),
          );
        this.logger.log({
          event:
            current && current.processingGeneration !== input.generation
              ? 'video.processing.stale_job_skipped'
              : 'video.processing.cancelled',
          videoId: input.videoId,
          jobId,
          generation: input.generation,
          currentGeneration: current?.processingGeneration,
          bullAttempt,
          correlationId: input.correlationId,
          reason: current?.status ?? 'deleted',
        });
        return;
      }
      throw error;
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }

  async fail(
    videoId: string,
    generation: number,
    publicReason: string,
  ): Promise<boolean> {
    try {
      await this.storage.removeGenerated(videoId, generation);
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.cleanup_failed',
        videoId,
        generation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    assertVideoTransition('PROCESSING', 'FAILED');
    const failed = await this.database.video.updateMany({
      where: {
        id: videoId,
        status: 'PROCESSING',
        processingGeneration: generation,
      },
      data: {
        status: 'FAILED',
        failureReason: publicReason.slice(0, 500),
        processingFinishedAt: new Date(),
      },
    });
    if (failed.count !== 1) {
      this.logger.log({
        event: 'video.processing.stale_job_skipped',
        videoId,
        generation,
        reason: 'stale_failure_ignored',
      });
      return false;
    }
    return true;
  }
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  assertVideoTransition,
  type ProcessVideoJob,
} from '@youtube-clone/types';

import { workerEnvironment } from './config.js';
import { DatabaseService } from './database.service.js';
import { selectRenditions, type GeneratedRendition } from './hls-renditions.js';
import { MediaToolsService } from './media-tools.service.js';
import {
  AttemptBusyError,
  AttemptLeaseExpiredError,
  AttemptOwnershipLostError,
  asProcessingError,
} from './processing-error.js';
import {
  AttemptLease,
  PUBLISH_TRANSACTION_OPTIONS,
  acquireAttempt,
  failStrandedGeneration,
  publishReadyIfOwned,
  releaseAttempt,
  type AttemptRef,
} from './processing-lease.js';
import { StorageService } from './storage.service.js';

export interface PipelineOptions {
  leaseSeconds?: number;
  renewIntervalMs?: number;
  attemptMaxMs?: number;
  /** Upper bound for cleanup work, which runs after the attempt is cancelled. */
  cleanupTimeoutMs?: number;
  /** Parent of the per-attempt temporary directories. */
  workRoot?: string;
}

export const PIPELINE_OPTIONS = Symbol('PIPELINE_OPTIONS');

@Injectable()
export class VideoProcessingPipeline {
  private readonly logger = new Logger(VideoProcessingPipeline.name);
  private readonly leaseSeconds: number;
  private readonly renewIntervalMs: number;
  private readonly attemptMaxMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly workRoot: string;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(MediaToolsService) private readonly mediaTools: MediaToolsService,
    @Optional() @Inject(PIPELINE_OPTIONS) options: PipelineOptions = {},
  ) {
    this.leaseSeconds =
      options.leaseSeconds ?? workerEnvironment.WORKER_LEASE_SECONDS;
    this.renewIntervalMs =
      options.renewIntervalMs ??
      Math.max(1_000, (this.leaseSeconds * 1_000) / 3);
    this.attemptMaxMs =
      options.attemptMaxMs ??
      workerEnvironment.WORKER_ATTEMPT_MAX_SECONDS * 1_000;
    this.cleanupTimeoutMs =
      options.cleanupTimeoutMs ??
      workerEnvironment.WORKER_CLEANUP_TIMEOUT_SECONDS * 1_000;
    this.workRoot = options.workRoot ?? tmpdir();
  }

  /**
   * Runs one attempt. `shutdownSignal` is the worker's: aborting it cancels the
   * attempt's work, after which the execution settles with a retryable error.
   */
  async execute(
    jobId: string,
    input: ProcessVideoJob,
    bullAttempt = 1,
    shutdownSignal?: AbortSignal,
  ): Promise<void> {
    const video = await this.database.video.findUnique({
      where: { id: input.videoId },
      include: {
        assets: { where: { id: input.originalAssetId, kind: 'ORIGINAL' } },
      },
    });
    const logContext = {
      videoId: input.videoId,
      jobId,
      generation: input.generation,
      bullAttempt,
      correlationId: input.correlationId,
    };
    if (!video) {
      this.logger.log({
        event: 'video.processing.cancelled',
        ...logContext,
        reason: 'video_deleted',
      });
      return;
    }
    if (video.processingGeneration !== input.generation) {
      this.logger.log({
        event: 'video.processing.stale_job_skipped',
        ...logContext,
        currentGeneration: video.processingGeneration,
      });
      return;
    }
    if (video.status === 'DELETING') {
      this.logger.log({
        event: 'video.processing.cancelled',
        ...logContext,
        reason: 'deleting',
      });
      return;
    }
    if (video.assets.length !== 1)
      throw new Error('Original asset was not found');
    if (video.status === 'READY' || video.status === 'FAILED') {
      this.logger.log({
        event: 'video.processing.duplicate_skipped',
        ...logContext,
        status: video.status,
      });
      return;
    }
    if (video.status !== 'UPLOADED' && video.status !== 'PROCESSING')
      throw new Error(`Video is not processable from ${video.status}`);
    if (video.status === 'UPLOADED')
      assertVideoTransition(video.status, 'PROCESSING');

    const acquiredAt = performance.now();
    const attemptId = await acquireAttempt(this.database, {
      videoId: video.id,
      generation: input.generation,
      leaseSeconds: this.leaseSeconds,
    });
    if (!attemptId) {
      if (await this.explainRejectedAcquisition(video.id, input, logContext))
        return;
      throw new AttemptBusyError();
    }
    const attempt: AttemptRef = {
      videoId: video.id,
      generation: input.generation,
      attemptId,
    };
    const lease = new AttemptLease(this.database, attempt, {
      leaseSeconds: this.leaseSeconds,
      renewIntervalMs: this.renewIntervalMs,
      maxDurationMs: this.attemptMaxMs,
      acquiredAt,
      shutdownSignal,
    });
    const attemptContext = { ...logContext, attemptId };
    const { signal } = lease;

    // Everything from here on is covered by the try/finally: the attempt owns
    // the generation now, so any failure must stop the heartbeat, clean up,
    // and surface an attempt-tagged error for the caller to release or fail.
    let committed = false;
    let workDirectory: string | undefined;
    try {
      lease.start();
      this.logger.log({
        event: 'video.processing.started',
        ...attemptContext,
      });
      signal.throwIfAborted();
      workDirectory = await mkdtemp(
        join(this.workRoot, `youtube-clone-${video.id}-`),
      );
      signal.throwIfAborted();
      const originalPath = join(workDirectory, 'original');
      const thumbnailPath = join(workDirectory, 'thumbnail.jpg');
      const hlsDirectory = join(workDirectory, 'hls');
      const original = video.assets[0]!;
      await this.storage.download(
        original.bucket,
        original.objectKey,
        originalPath,
        original.sizeBytes,
        signal,
      );
      const metadata = await this.mediaTools.probe(originalPath, signal);
      const thumbnailSize = await this.mediaTools.generateThumbnail(
        originalPath,
        thumbnailPath,
        metadata,
        signal,
      );
      const renditionSpecs = selectRenditions({
        sourceWidth: metadata.width,
        sourceHeight: metadata.height,
        hasAudio: metadata.audioCodec !== null,
      });
      const generatedRenditions: GeneratedRendition[] = [];
      for (const spec of renditionSpecs) {
        signal.throwIfAborted();
        const startedAt = performance.now();
        this.logger.log({
          event: 'video.processing.rendition.started',
          ...attemptContext,
          rendition: spec.name,
        });
        const generated = await this.mediaTools.generateHlsRendition(
          originalPath,
          hlsDirectory,
          spec,
          signal,
        );
        generatedRenditions.push(generated);
        this.logger.log({
          event: 'video.processing.rendition.completed',
          ...attemptContext,
          rendition: spec.name,
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      signal.throwIfAborted();
      const masterStartedAt = performance.now();
      await this.mediaTools.generateHlsMaster(
        hlsDirectory,
        generatedRenditions,
      );
      this.logger.log({
        event: 'video.processing.master.created',
        ...attemptContext,
        renditionCount: generatedRenditions.length,
        durationMs: Math.round(performance.now() - masterStartedAt),
      });

      // Verified ownership gates every step that creates storage objects. The
      // objects live under this attempt's own prefix, so they cannot collide
      // with another attempt's output even if ownership is lost afterwards.
      await lease.ensureOwned();
      const thumbnail = await this.storage.uploadThumbnail(
        video.id,
        input.generation,
        attemptId,
        thumbnailPath,
        signal,
      );
      const hls = await this.storage.uploadHls(
        video.id,
        input.generation,
        attemptId,
        hlsDirectory,
        renditionSpecs.map((spec) => spec.name),
        signal,
      );
      await lease.ensureOwned();

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

      // The fenced READY transition is the first statement, so it takes the row
      // lock that any competing takeover would need; asset publication commits
      // atomically with it or not at all.
      await this.database.$transaction(async (transaction) => {
        assertVideoTransition('PROCESSING', 'READY');
        const completed = await publishReadyIfOwned(transaction, attempt, {
          durationSeconds: Math.round(metadata.durationSeconds),
          width: metadata.width,
          height: metadata.height,
        });
        if (!completed) throw new AttemptOwnershipLostError();
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
        await transaction.videoAsset.deleteMany({
          where: {
            videoId: video.id,
            kind: { in: ['THUMBNAIL', 'HLS_MANIFEST', 'HLS_RENDITION'] },
            OR: [{ attemptId: null }, { attemptId: { not: attemptId } }],
          },
        });
        await transaction.videoAsset.create({
          data: {
            videoId: video.id,
            kind: 'THUMBNAIL',
            bucket: thumbnail.bucket,
            objectKey: thumbnail.objectKey,
            mimeType: 'image/jpeg',
            sizeBytes: thumbnail.sizeBytes,
            width: thumbnailSize.width,
            height: thumbnailSize.height,
            attemptId,
          },
        });
        await transaction.videoAsset.create({
          data: {
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
            attemptId,
          },
        });
        await transaction.video.updateMany({
          where: {
            id: video.id,
            status: 'READY',
            visibility: 'PUBLIC',
            publishedAt: null,
          },
          data: { publishedAt: new Date() },
        });
      }, PUBLISH_TRANSACTION_OPTIONS);
      committed = true;
      await this.removeObsolete(attempt, attemptContext);
      this.logger.log({
        event: 'video.processing.ready',
        ...attemptContext,
        durationSeconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        renditionCount: generatedRenditions.length,
      });
    } catch (thrown) {
      // Cancellation outranks whatever the interrupted operation reported.
      const error: unknown = signal.aborted ? signal.reason : thrown;
      const outcome = await this.classifyFailure(
        attempt,
        error,
        attemptContext,
      );
      if (outcome === 'committed') {
        committed = true;
        await this.removeObsolete(attempt, attemptContext);
        return;
      }
      if (outcome === 'abandoned') return;
      throw this.tag(outcome, attemptId);
    } finally {
      lease.stop();
      try {
        if (!committed) await this.cleanupUnpublished(attempt);
      } finally {
        if (workDirectory) await this.removeWorkDirectory(workDirectory);
      }
    }
  }

  private async removeWorkDirectory(directory: string): Promise<void> {
    try {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.workdir_cleanup_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Records a terminal failure, but only for the attempt that owns the
   * generation. A late failure from a superseded or finished attempt cannot
   * change lifecycle state, and no storage is touched unless the state change
   * proves this attempt still owned the work.
   */
  async fail(attempt: AttemptRef, publicReason: string): Promise<boolean> {
    assertVideoTransition('PROCESSING', 'FAILED');
    const failed = await this.database.video.updateMany({
      where: {
        id: attempt.videoId,
        status: 'PROCESSING',
        processingGeneration: attempt.generation,
        processingAttemptId: attempt.attemptId,
      },
      data: {
        status: 'FAILED',
        failureReason: publicReason.slice(0, 500),
        processingFinishedAt: new Date(),
        processingAttemptId: null,
        processingLeaseExpiresAt: null,
      },
    });
    if (failed.count !== 1) {
      this.logger.log({
        event: 'video.processing.stale_job_skipped',
        videoId: attempt.videoId,
        generation: attempt.generation,
        attemptId: attempt.attemptId,
        reason: 'stale_failure_ignored',
      });
      return false;
    }
    await this.cleanupUnpublished(attempt);
    return true;
  }

  /**
   * Fallback for jobs BullMQ failed terminally outside `process()` (stalls).
   * Lease-conditional, so a live worker is never interrupted.
   */
  async failStranded(
    videoId: string,
    generation: number,
    publicReason: string,
  ): Promise<boolean> {
    const before = await this.database.video.findUnique({
      where: { id: videoId },
      select: { processingAttemptId: true },
    });
    const failed = await failStrandedGeneration(this.database, {
      videoId,
      generation,
      reason: publicReason,
    });
    if (failed && before?.processingAttemptId) {
      await this.cleanupUnpublished({
        videoId,
        generation,
        attemptId: before.processingAttemptId,
      });
    }
    return failed;
  }

  /** Hands the generation back for an immediate retry by the next delivery. */
  async release(attempt: AttemptRef): Promise<boolean> {
    return releaseAttempt(this.database, attempt);
  }

  private tag(error: unknown, attemptId: string) {
    const processingError = asProcessingError(error);
    processingError.attemptId = attemptId;
    return processingError;
  }

  /** Explains why acquisition found nothing to take; true when the job is moot. */
  private async explainRejectedAcquisition(
    videoId: string,
    input: ProcessVideoJob,
    logContext: Record<string, unknown>,
  ): Promise<boolean> {
    const current = await this.database.video.findUnique({
      where: { id: videoId },
      select: { status: true, processingGeneration: true },
    });
    if (!current) {
      this.logger.log({
        event: 'video.processing.cancelled',
        ...logContext,
        reason: 'video_deleted',
      });
      return true;
    }
    if (current.processingGeneration !== input.generation) {
      this.logger.log({
        event: 'video.processing.stale_job_skipped',
        ...logContext,
        currentGeneration: current.processingGeneration,
      });
      return true;
    }
    if (current.status !== 'UPLOADED' && current.status !== 'PROCESSING') {
      this.logger.log({
        event:
          current.status === 'DELETING'
            ? 'video.processing.cancelled'
            : 'video.processing.duplicate_skipped',
        ...logContext,
        reason: current.status,
      });
      return true;
    }
    this.logger.warn({
      event: 'video.processing.attempt_busy',
      ...logContext,
    });
    return false;
  }

  /**
   * Decides what a failed execution means once its own error is known:
   * - 'abandoned': the video was deleted, superseded by a newer generation, or
   *   is being deleted; this is a cancellation, not a failure.
   * - 'committed': the READY transaction committed even though the call failed.
   * - otherwise the error to surface (ownership loss when another attempt owns
   *   or already published the generation).
   */
  private async classifyFailure(
    attempt: AttemptRef,
    error: unknown,
    logContext: Record<string, unknown>,
  ): Promise<unknown> {
    let current;
    try {
      current = await this.database.video.findUnique({
        where: { id: attempt.videoId },
        select: {
          status: true,
          processingGeneration: true,
          processingAttemptId: true,
          committedAttemptId: true,
        },
      });
    } catch {
      return error;
    }
    if (current?.committedAttemptId === attempt.attemptId) return 'committed';
    if (
      !current ||
      current.status === 'DELETING' ||
      current.processingGeneration !== attempt.generation
    ) {
      this.logger.log({
        event:
          current && current.processingGeneration !== attempt.generation
            ? 'video.processing.stale_job_skipped'
            : 'video.processing.cancelled',
        ...logContext,
        currentGeneration: current?.processingGeneration,
        reason: current?.status ?? 'deleted',
      });
      return 'abandoned';
    }
    const ownsStill =
      current.status === 'PROCESSING' &&
      current.processingAttemptId === attempt.attemptId;
    if (ownsStill) {
      // Still the recorded owner although the attempt thinks it lost
      // ownership: nobody superseded it, its lease simply ran out. That is an
      // interruption to retry, not a verdict of another attempt.
      if (error instanceof AttemptOwnershipLostError) {
        this.logger.warn({
          event: 'video.processing.lease_expired',
          ...logContext,
        });
        return new AttemptLeaseExpiredError();
      }
      return error;
    }
    this.logger.warn({
      event: 'video.processing.ownership_lost',
      ...logContext,
      currentStatus: current.status,
    });
    return error instanceof AttemptOwnershipLostError
      ? error
      : new AttemptOwnershipLostError();
  }

  /**
   * Removes this attempt's objects unless the database says this attempt is the
   * committed one. If the state cannot be read, nothing is deleted: an orphan is
   * recoverable, a deleted published rendition is not.
   */
  private async cleanupUnpublished(attempt: AttemptRef): Promise<void> {
    try {
      const current = await this.database.video.findUnique({
        where: { id: attempt.videoId },
        select: { committedAttemptId: true },
      });
      if (current?.committedAttemptId === attempt.attemptId) return;
      await this.storage.removeAttempt(
        attempt.videoId,
        attempt.generation,
        attempt.attemptId,
        AbortSignal.timeout(this.cleanupTimeoutMs),
      );
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.cleanup_failed',
        videoId: attempt.videoId,
        generation: attempt.generation,
        attemptId: attempt.attemptId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async removeObsolete(
    attempt: AttemptRef,
    logContext: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.storage.removeObsoleteGenerated(
        attempt.videoId,
        attempt.generation,
        attempt.attemptId,
        AbortSignal.timeout(this.cleanupTimeoutMs),
      );
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.cleanup_failed',
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

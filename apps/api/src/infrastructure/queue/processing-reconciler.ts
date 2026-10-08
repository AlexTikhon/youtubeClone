import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

import type { ApiEnvironment } from '@youtube-clone/config';

import { API_ENVIRONMENT } from '../../config/config.module.js';
import { PrismaService } from '../database/prisma.service.js';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port.js';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingQueue,
} from './video-processing-queue.port.js';

export const PROCESSING_RECONCILER_OPTIONS = Symbol(
  'PROCESSING_RECONCILER_OPTIONS',
);

export interface ProcessingReconcilerOptions {
  /** How often each API instance scans. Multiple instances are safe. */
  intervalMs: number;
  /** Published events younger than this are never inspected. */
  graceSeconds: number;
  /** Minimum time between inspections of one generation, across instances. */
  cooldownSeconds: number;
  /** Re-publications of one generation before it is failed for the owner. */
  maxRecoveries: number;
  /** Generations inspected per scan. */
  batchSize: number;
}

const DEFAULT_OPTIONS: ProcessingReconcilerOptions = {
  intervalMs: 30_000,
  graceSeconds: 180,
  cooldownSeconds: 120,
  maxRecoveries: 5,
  batchSize: 20,
};

export interface ReconcileSummary {
  inspected: number;
  healthy: number;
  republished: number;
  failed: number;
  skipped: number;
}

interface Candidate {
  outboxId: string;
  videoId: string;
  generation: number;
  originalAssetId: string;
  correlationId: string;
  recoveryAttempts: number;
  processingAttemptId: string | null;
}

type Outcome = 'skipped' | 'healthy' | 'republished' | 'failed';

const STOPPED_REASON = 'Video processing stopped unexpectedly. Retry it.';
const UNRECOVERABLE_REASON =
  'Video processing could not be recovered automatically. Retry it.';
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

/**
 * Backstop for generations whose database state says "work is pending" while no
 * worker is actually doing it: the queue job vanished (Redis is disposable), or
 * BullMQ gave up on it outside the worker's own error handling (terminal
 * stalls). PostgreSQL stays authoritative; every action is a conditional,
 * idempotent write, so several API instances can run this concurrently.
 *
 * It never touches a generation whose attempt lease is still valid, and a
 * recovery revokes the expired owner so a delayed former attempt cannot publish.
 */
@Injectable()
export class ProcessingReconciler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ProcessingReconciler.name);
  private readonly options: ProcessingReconcilerOptions;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VIDEO_PROCESSING_QUEUE)
    private readonly queue: VideoProcessingQueue,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
    @Optional()
    @Inject(PROCESSING_RECONCILER_OPTIONS)
    options?: Partial<ProcessingReconcilerOptions>,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(
      () => void this.reconcile(),
      this.options.intervalMs,
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcile(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      inspected: 0,
      healthy: 0,
      republished: 0,
      failed: 0,
      skipped: 0,
    };
    if (this.running) return summary;
    this.running = true;
    try {
      for (const candidate of await this.findCandidates()) {
        try {
          const outcome = await this.reconcileOne(candidate);
          if (outcome === 'skipped') summary.skipped += 1;
          else {
            summary.inspected += 1;
            summary[outcome] += 1;
          }
        } catch (error) {
          this.logger.warn({
            event: 'video.processing.reconcile_failed',
            videoId: candidate.videoId,
            generation: candidate.generation,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.reconcile_scan_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
    return summary;
  }

  /**
   * Published events whose generation is still pending, whose attempt lease is
   * not valid, and that have not been inspected within the cooldown. Bounded by
   * the batch size and ordered oldest first.
   */
  private findCandidates(): Promise<Candidate[]> {
    const { graceSeconds, cooldownSeconds, batchSize } = this.options;
    return this.prisma.$queryRawUnsafe<Candidate[]>(
      `SELECT o."id" AS "outboxId", o."videoId", o."generation",
              o."originalAssetId", o."correlationId", o."recoveryAttempts",
              v."processingAttemptId"
       FROM "ProcessingOutbox" o
       JOIN "Video" v
         ON v."id" = o."videoId" AND v."processingGeneration" = o."generation"
       WHERE o."publishedAt" IS NOT NULL
         AND o."publishedAt" <= ${UTC_NOW} - make_interval(secs => $1::double precision)
         AND v."status" IN ('UPLOADED', 'PROCESSING')
         AND (v."processingAttemptId" IS NULL
              OR v."processingLeaseExpiresAt" IS NULL
              OR v."processingLeaseExpiresAt" <= ${UTC_NOW})
         AND (o."lastRecoveredAt" IS NULL
              OR o."lastRecoveredAt" <= ${UTC_NOW} - make_interval(secs => $2::double precision))
       ORDER BY o."publishedAt" ASC
       LIMIT $3::int`,
      graceSeconds,
      cooldownSeconds,
      batchSize,
    );
  }

  private async reconcileOne(candidate: Candidate): Promise<Outcome> {
    // Exactly one instance wins each cooldown window for a generation.
    const claimed = await this.prisma.$executeRawUnsafe(
      `UPDATE "ProcessingOutbox" SET "lastRecoveredAt" = ${UTC_NOW}
       WHERE "id" = $1::uuid
         AND ("lastRecoveredAt" IS NULL
              OR "lastRecoveredAt" <= ${UTC_NOW} - make_interval(secs => $2::double precision))`,
      candidate.outboxId,
      this.options.cooldownSeconds,
    );
    if (claimed !== 1) return 'skipped';

    const ref = {
      videoId: candidate.videoId,
      generation: candidate.generation,
    };
    const jobState = await this.queue.getState(ref);
    const context = {
      videoId: candidate.videoId,
      generation: candidate.generation,
      correlationId: candidate.correlationId,
      jobState,
      attemptId: candidate.processingAttemptId,
    };

    if (jobState === 'queued' || jobState === 'active') {
      this.logger.log({
        event: 'video.processing.reconciled',
        outcome: 'healthy',
        ...context,
      });
      return 'healthy';
    }
    if (jobState === 'failed')
      return this.failGeneration(candidate, STOPPED_REASON, context);
    // 'missing' or a retained 'completed' job that no longer matches database state.
    if (candidate.recoveryAttempts >= this.options.maxRecoveries)
      return this.failGeneration(candidate, UNRECOVERABLE_REASON, context);

    const revoked = await this.revokeExpiredOwner(candidate);
    if (!revoked) {
      this.logger.log({
        event: 'video.processing.reconciled',
        outcome: 'raced',
        ...context,
      });
      return 'skipped';
    }
    await this.queue.requeue({
      schemaVersion: 1,
      videoId: candidate.videoId,
      originalAssetId: candidate.originalAssetId,
      generation: candidate.generation,
      correlationId: candidate.correlationId,
    });
    await this.prisma.processingOutbox.update({
      where: { id: candidate.outboxId },
      data: { recoveryAttempts: { increment: 1 } },
    });
    this.logger.log({
      event: 'video.processing.reconciled',
      outcome: 'republished',
      recoveryAttempt: candidate.recoveryAttempts + 1,
      ...context,
    });
    return 'republished';
  }

  /**
   * Clears an expired attempt so it can no longer renew or publish. Fails if a
   * new live attempt appeared since the scan.
   */
  private async revokeExpiredOwner(candidate: Candidate): Promise<boolean> {
    const revoked = await this.prisma.$executeRawUnsafe(
      `UPDATE "Video"
       SET "processingAttemptId" = NULL, "processingLeaseExpiresAt" = NULL,
           "updatedAt" = ${UTC_NOW}
       WHERE "id" = $1::uuid AND "processingGeneration" = $2::int
         AND "status" IN ('UPLOADED', 'PROCESSING')
         AND ("processingAttemptId" IS NULL
              OR "processingLeaseExpiresAt" IS NULL
              OR "processingLeaseExpiresAt" <= ${UTC_NOW})`,
      candidate.videoId,
      candidate.generation,
    );
    return revoked === 1;
  }

  /** Terminal, owner-recoverable failure; skipped when a live lease appeared. */
  private async failGeneration(
    candidate: Candidate,
    reason: string,
    context: Record<string, unknown>,
  ): Promise<Outcome> {
    const failed = await this.prisma.$executeRawUnsafe(
      `UPDATE "Video"
       SET "status" = 'FAILED', "failureReason" = $3,
           "processingFinishedAt" = ${UTC_NOW},
           "processingAttemptId" = NULL, "processingLeaseExpiresAt" = NULL,
           "updatedAt" = ${UTC_NOW}
       WHERE "id" = $1::uuid AND "processingGeneration" = $2::int
         AND "status" IN ('UPLOADED', 'PROCESSING')
         AND ("processingAttemptId" IS NULL
              OR "processingLeaseExpiresAt" IS NULL
              OR "processingLeaseExpiresAt" <= ${UTC_NOW})`,
      candidate.videoId,
      candidate.generation,
      reason,
    );
    if (failed !== 1) {
      this.logger.log({
        event: 'video.processing.reconciled',
        outcome: 'raced',
        ...context,
      });
      return 'skipped';
    }
    this.logger.warn({
      event: 'video.processing.reconciled',
      outcome: 'failed',
      ...context,
    });
    await this.removeOrphanedAttempt(candidate);
    return 'failed';
  }

  /** Best-effort removal of the dead attempt's never-published objects. */
  private async removeOrphanedAttempt(candidate: Candidate): Promise<void> {
    if (!candidate.processingAttemptId) return;
    const prefix = `videos/${candidate.videoId}/generations/${candidate.generation}/attempts/${candidate.processingAttemptId}/`;
    try {
      await Promise.all([
        this.storage.deletePrefix(this.environment.S3_BUCKET_STREAMS, prefix),
        this.storage.deletePrefix(
          this.environment.S3_BUCKET_THUMBNAILS,
          prefix,
        ),
      ]);
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.reconcile_cleanup_failed',
        videoId: candidate.videoId,
        generation: candidate.generation,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

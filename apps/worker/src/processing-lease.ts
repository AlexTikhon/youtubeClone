import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import {
  AttemptOwnershipLostError,
  ProcessingError,
} from './processing-error.js';

/**
 * Identity of one worker execution inside a processing generation. Generation
 * fencing alone cannot tell overlapping executions of the same generation
 * apart; the attempt identity plus a renewable database lease can.
 */
export interface AttemptRef {
  videoId: string;
  generation: number;
  attemptId: string;
}

export type LeaseDatabase = Pick<PrismaClient, 'video' | '$executeRaw'>;

/**
 * Atomically acquires the generation for a new attempt, or takes it over when
 * the previous owner's lease expired. All lease arithmetic uses the database
 * clock so worker hosts with skewed clocks cannot steal a live lease.
 * Returns the new attempt ID, or null when another live attempt owns it or the
 * video is no longer processable for that generation.
 */
export async function acquireAttempt(
  database: LeaseDatabase,
  input: { videoId: string; generation: number; leaseSeconds: number },
): Promise<string | null> {
  const attemptId = randomUUID();
  const acquired = await database.$executeRaw`
    UPDATE "Video"
    SET "status" = 'PROCESSING',
        "processingAttemptId" = ${attemptId}::uuid,
        "processingLeaseExpiresAt" =
          (now() AT TIME ZONE 'UTC') + make_interval(secs => ${input.leaseSeconds}::double precision),
        "processingStartedAt" = COALESCE("processingStartedAt", now() AT TIME ZONE 'UTC'),
        "processingFinishedAt" = NULL,
        "failureReason" = NULL,
        "updatedAt" = now() AT TIME ZONE 'UTC'
    WHERE "id" = ${input.videoId}::uuid
      AND "processingGeneration" = ${input.generation}::int
      AND "status" IN ('UPLOADED', 'PROCESSING')
      AND (
        "processingAttemptId" IS NULL
        OR "processingLeaseExpiresAt" IS NULL
        OR "processingLeaseExpiresAt" <= (now() AT TIME ZONE 'UTC')
      )`;
  return acquired === 1 ? attemptId : null;
}

/** Extends the lease only while this attempt is still the recorded owner. */
export async function renewAttempt(
  database: LeaseDatabase,
  attempt: AttemptRef,
  leaseSeconds: number,
): Promise<boolean> {
  const renewed = await database.$executeRaw`
    UPDATE "Video"
    SET "processingLeaseExpiresAt" =
          (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseSeconds}::double precision),
        "updatedAt" = now() AT TIME ZONE 'UTC'
    WHERE "id" = ${attempt.videoId}::uuid
      AND "processingGeneration" = ${attempt.generation}::int
      AND "processingAttemptId" = ${attempt.attemptId}::uuid
      AND "status" = 'PROCESSING'`;
  return renewed === 1;
}

/** Hands the generation back so the next delivery can acquire it immediately. */
export async function releaseAttempt(
  database: LeaseDatabase,
  attempt: AttemptRef,
): Promise<boolean> {
  const released = await database.video.updateMany({
    where: {
      id: attempt.videoId,
      status: 'PROCESSING',
      processingGeneration: attempt.generation,
      processingAttemptId: attempt.attemptId,
    },
    data: { processingAttemptId: null, processingLeaseExpiresAt: null },
  });
  return released.count === 1;
}

/**
 * Moves a generation to the owner-recoverable FAILED state after BullMQ gave up
 * on it outside the normal error path (for example a terminal stall). A valid
 * lease is a live worker and is never overridden; clearing the attempt also
 * stops an expired owner from renewing or publishing later.
 */
export async function failStrandedGeneration(
  database: LeaseDatabase,
  input: { videoId: string; generation: number; reason: string },
): Promise<boolean> {
  const failed = await database.$executeRaw`
    UPDATE "Video"
    SET "status" = 'FAILED',
        "failureReason" = ${input.reason.slice(0, 500)},
        "processingFinishedAt" = now() AT TIME ZONE 'UTC',
        "processingAttemptId" = NULL,
        "processingLeaseExpiresAt" = NULL,
        "updatedAt" = now() AT TIME ZONE 'UTC'
    WHERE "id" = ${input.videoId}::uuid
      AND "processingGeneration" = ${input.generation}::int
      AND "status" IN ('UPLOADED', 'PROCESSING')
      AND (
        "processingAttemptId" IS NULL
        OR "processingLeaseExpiresAt" IS NULL
        OR "processingLeaseExpiresAt" <= (now() AT TIME ZONE 'UTC')
      )`;
  return failed === 1;
}

export interface AttemptLeaseOptions {
  leaseSeconds: number;
  renewIntervalMs: number;
  /** After this, the attempt stops renewing and becomes recoverable. */
  maxDurationMs: number;
}

/**
 * Keeps one attempt's lease alive while FFmpeg and uploads run outside any
 * transaction. `ensureOwned` is both a heartbeat and an authoritative,
 * database-verified ownership check used before every publication step.
 */
export class AttemptLease {
  private readonly logger = new Logger(AttemptLease.name);
  private readonly startedAt = Date.now();
  private timer?: ReturnType<typeof setInterval>;
  private lost = false;

  constructor(
    private readonly database: LeaseDatabase,
    readonly attempt: AttemptRef,
    private readonly options: AttemptLeaseOptions,
  ) {}

  start(): void {
    this.timer = setInterval(
      () => void this.heartbeat(),
      this.options.renewIntervalMs,
    );
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async ensureOwned(): Promise<void> {
    if (this.lost) throw new AttemptOwnershipLostError();
    if (this.exceededMaxDuration()) {
      throw new ProcessingError(
        'The processing attempt exceeded its maximum duration',
        true,
        'Video processing timed out',
      );
    }
    if (!(await this.renew())) throw new AttemptOwnershipLostError();
  }

  private exceededMaxDuration(): boolean {
    return Date.now() - this.startedAt > this.options.maxDurationMs;
  }

  private async renew(): Promise<boolean> {
    const renewed = await renewAttempt(
      this.database,
      this.attempt,
      this.options.leaseSeconds,
    );
    if (!renewed) {
      this.lost = true;
      this.stop();
    }
    return renewed;
  }

  private async heartbeat(): Promise<void> {
    if (this.exceededMaxDuration()) {
      this.logger.warn({
        event: 'video.processing.lease_max_duration_exceeded',
        videoId: this.attempt.videoId,
        generation: this.attempt.generation,
        attemptId: this.attempt.attemptId,
      });
      this.stop();
      return;
    }
    try {
      if (!(await this.renew())) {
        this.logger.warn({
          event: 'video.processing.lease_lost',
          videoId: this.attempt.videoId,
          generation: this.attempt.generation,
          attemptId: this.attempt.attemptId,
        });
      }
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.lease_renewal_failed',
        videoId: this.attempt.videoId,
        generation: this.attempt.generation,
        attemptId: this.attempt.attemptId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import {
  AttemptDeadlineError,
  AttemptLeaseExpiredError,
  AttemptOwnershipLostError,
  WorkerShutdownError,
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

/**
 * Extends the lease only while this attempt is still the recorded owner AND the
 * lease has not expired. An expired lease is never resurrected, even when no
 * other attempt took over: after expiry the generation belongs to whoever
 * acquires it next. Expiry is judged with `clock_timestamp()` so a statement
 * that waited on a row lock is measured at evaluation time, not statement
 * start.
 */
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
      AND "status" = 'PROCESSING'
      AND "processingLeaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')`;
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

/** The publication runs in a short transaction; no wait inside it is unbounded. */
const PUBLISH_LOCK_TIMEOUT_MS = 5_000;
const PUBLISH_STATEMENT_TIMEOUT_MS = 10_000;
export const PUBLISH_TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 20_000,
} as const;

export type PublicationTransaction = Pick<
  PrismaClient,
  '$executeRaw' | '$executeRawUnsafe' | '$queryRaw'
>;

/**
 * First statements of the READY transaction. It succeeds only for the attempt
 * that is still the recorded owner of an unexpired lease, and the ownership
 * and expiry condition is part of the one UPDATE that publishes, so there is
 * no separate check to race.
 *
 * The row lock is taken first and held until commit. The condition is then
 * evaluated after any lock wait, with `clock_timestamp()` rather than `now()`
 * (which is frozen at transaction start). Without that, a wait behind another
 * writer could let the lease expire between evaluating the condition and
 * applying the update. Once the UPDATE has run, any competing takeover blocks
 * on this transaction and then sees a READY row.
 */
export async function publishReadyIfOwned(
  transaction: PublicationTransaction,
  attempt: AttemptRef,
  data: { durationSeconds: number; width: number; height: number },
): Promise<boolean> {
  await transaction.$executeRawUnsafe(
    `SET LOCAL lock_timeout = ${PUBLISH_LOCK_TIMEOUT_MS}`,
  );
  await transaction.$executeRawUnsafe(
    `SET LOCAL statement_timeout = ${PUBLISH_STATEMENT_TIMEOUT_MS}`,
  );
  await transaction.$queryRaw`
    SELECT 1 FROM "Video" WHERE "id" = ${attempt.videoId}::uuid FOR UPDATE`;
  const published = await transaction.$executeRaw`
    UPDATE "Video"
    SET "status" = 'READY',
        "durationSeconds" = ${data.durationSeconds}::int,
        "width" = ${data.width}::int,
        "height" = ${data.height}::int,
        "failureReason" = NULL,
        "processingFinishedAt" = clock_timestamp() AT TIME ZONE 'UTC',
        "committedAttemptId" = ${attempt.attemptId}::uuid,
        "processingAttemptId" = NULL,
        "processingLeaseExpiresAt" = NULL,
        "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
    WHERE "id" = ${attempt.videoId}::uuid
      AND "processingGeneration" = ${attempt.generation}::int
      AND "processingAttemptId" = ${attempt.attemptId}::uuid
      AND "status" = 'PROCESSING'
      AND "processingLeaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')`;
  return published === 1;
}

/**
 * Rejects with `signal.reason` as soon as the signal aborts, otherwise settles
 * like `promise`. It never cancels the underlying work; it only stops waiting,
 * so it is for database calls that have no cancellation of their own.
 */
export function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export interface AttemptLeaseOptions {
  leaseSeconds: number;
  renewIntervalMs: number;
  /** Hard ceiling: when it passes, the attempt's work is cancelled. */
  maxDurationMs: number;
  /**
   * `performance.now()` taken before the acquisition request was sent. Anchoring
   * local validity and the deadline here keeps them conservative: the database
   * lease cannot start earlier than this instant.
   */
  acquiredAt?: number;
  /** Aborts when the worker begins shutting down. */
  shutdownSignal?: AbortSignal;
}

/**
 * One cancellation lifecycle per attempt. `signal` aborts, with a typed
 * `ProcessingError` as its reason, when any of these happens first:
 *  - the hard deadline passes (`AttemptDeadlineError`);
 *  - a renewal shows the attempt no longer owns the generation
 *    (`AttemptOwnershipLostError`);
 *  - the lease can no longer be confirmed: no renewal succeeded within the
 *    lease length, e.g. because the database is unreachable
 *    (`AttemptLeaseExpiredError`);
 *  - the worker shuts down (`WorkerShutdownError`).
 *
 * Renewals are serialized, never overlap, and never start after `stop()`.
 * `ensureOwned` is both a heartbeat and an authoritative, database-verified
 * ownership check used before publication steps.
 */
export class AttemptLease {
  private readonly logger = new Logger(AttemptLease.name);
  private readonly controller = new AbortController();
  private readonly acquiredAt: number;
  private validUntil: number;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private validityTimer?: ReturnType<typeof setTimeout>;
  private renewals: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly onShutdown = () => this.cancel(new WorkerShutdownError());

  constructor(
    private readonly database: LeaseDatabase,
    readonly attempt: AttemptRef,
    private readonly options: AttemptLeaseOptions,
  ) {
    this.acquiredAt = options.acquiredAt ?? performance.now();
    this.validUntil = this.acquiredAt + options.leaseSeconds * 1_000;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.stopped || this.signal.aborted) return;
    const shutdown = this.options.shutdownSignal;
    if (shutdown?.aborted) {
      this.cancel(new WorkerShutdownError());
      return;
    }
    shutdown?.addEventListener('abort', this.onShutdown, { once: true });
    this.deadlineTimer = setTimeout(
      () => this.cancel(new AttemptDeadlineError()),
      Math.max(
        0,
        this.acquiredAt + this.options.maxDurationMs - performance.now(),
      ),
    );
    this.deadlineTimer.unref();
    this.armValidity();
    this.scheduleHeartbeat();
  }

  /** Ends the lifecycle: no timers, no further renewals, and the signal aborts. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    if (!this.signal.aborted)
      this.controller.abort(new Error('The processing attempt finished'));
  }

  async ensureOwned(): Promise<void> {
    this.signal.throwIfAborted();
    const confirmed = await untilAborted(this.renew(), this.signal);
    this.signal.throwIfAborted();
    if (!confirmed) throw new AttemptOwnershipLostError();
  }

  private cancel(reason: Error): void {
    if (this.signal.aborted) return;
    this.clearTimers();
    this.logger.warn({
      event: 'video.processing.attempt_cancelled',
      videoId: this.attempt.videoId,
      generation: this.attempt.generation,
      attemptId: this.attempt.attemptId,
      reason: reason.name,
    });
    this.controller.abort(reason);
  }

  private clearTimers(): void {
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.validityTimer);
    this.heartbeatTimer = this.deadlineTimer = this.validityTimer = undefined;
    this.options.shutdownSignal?.removeEventListener('abort', this.onShutdown);
  }

  /** Cancels the attempt if no renewal is confirmed before the lease can end. */
  private armValidity(): void {
    clearTimeout(this.validityTimer);
    if (this.stopped || this.signal.aborted) return;
    this.validityTimer = setTimeout(
      () => this.cancel(new AttemptLeaseExpiredError()),
      Math.max(0, this.validUntil - performance.now()),
    );
    this.validityTimer.unref();
  }

  private scheduleHeartbeat(): void {
    if (this.stopped || this.signal.aborted) return;
    this.heartbeatTimer = setTimeout(
      () => void this.heartbeat(),
      this.options.renewIntervalMs,
    );
    this.heartbeatTimer.unref();
  }

  /** One renewal at a time; each starts only after the previous one settled. */
  private renew(): Promise<boolean> {
    const run = this.renewals.then(() => this.renewOnce());
    this.renewals = run.catch(() => undefined);
    return run;
  }

  private async renewOnce(): Promise<boolean> {
    // Queued renewals run later than they were requested; one that outlives
    // the attempt must not touch the database.
    if (this.stopped || this.signal.aborted) return false;
    const sentAt = performance.now();
    const renewed = await renewAttempt(
      this.database,
      this.attempt,
      this.options.leaseSeconds,
    );
    if (this.stopped || this.signal.aborted) return renewed;
    if (renewed) {
      this.validUntil = Math.max(
        this.validUntil,
        sentAt + this.options.leaseSeconds * 1_000,
      );
      this.armValidity();
    } else {
      this.logger.warn({
        event: 'video.processing.lease_lost',
        videoId: this.attempt.videoId,
        generation: this.attempt.generation,
        attemptId: this.attempt.attemptId,
      });
      this.cancel(new AttemptOwnershipLostError());
    }
    return renewed;
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.renew();
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.lease_renewal_failed',
        videoId: this.attempt.videoId,
        generation: this.attempt.generation,
        attemptId: this.attempt.attemptId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.scheduleHeartbeat();
  }
}

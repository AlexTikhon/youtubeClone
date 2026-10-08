import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';

import {
  VIDEO_PROCESSING_QUEUE_NAME,
  type ProcessVideoJob,
} from '@youtube-clone/types';

import { workerEnvironment } from './config.js';
import { processVideoJobSchema } from './video-job.schema.js';
import { VideoProcessingPipeline } from './video-processing.pipeline.js';
import { WorkerShutdownError, asProcessingError } from './processing-error.js';

export interface VideoWorkerOptions {
  queueName?: string;
  concurrency?: number;
  /** How long shutdown lets running attempts finish before cancelling them. */
  shutdownGraceMs?: number;
  /** How long cancelled attempts get to settle (cleanup included). */
  settleTimeoutMs?: number;
  /** How long closing the BullMQ worker may take. */
  closeTimeoutMs?: number;
}

export const VIDEO_WORKER_OPTIONS = Symbol('VIDEO_WORKER_OPTIONS');

@Injectable()
export class VideoWorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(VideoWorkerService.name);
  private worker?: Worker<ProcessVideoJob>;
  private readonly active = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private readonly options: Required<VideoWorkerOptions>;

  constructor(
    @Inject(VideoProcessingPipeline)
    private readonly pipeline: VideoProcessingPipeline,
    @Optional()
    @Inject(VIDEO_WORKER_OPTIONS)
    options: VideoWorkerOptions = {},
  ) {
    this.options = {
      queueName: options.queueName ?? VIDEO_PROCESSING_QUEUE_NAME,
      concurrency: options.concurrency ?? workerEnvironment.WORKER_CONCURRENCY,
      shutdownGraceMs:
        options.shutdownGraceMs ??
        workerEnvironment.WORKER_SHUTDOWN_GRACE_SECONDS * 1_000,
      settleTimeoutMs:
        options.settleTimeoutMs ??
        workerEnvironment.WORKER_CLEANUP_TIMEOUT_SECONDS * 1_000 + 5_000,
      closeTimeoutMs: options.closeTimeoutMs ?? 5_000,
    };
  }

  onApplicationBootstrap(): void {
    this.worker = new Worker<ProcessVideoJob>(
      this.options.queueName,
      (job) => this.process(job),
      {
        connection: {
          url: workerEnvironment.REDIS_URL,
          maxRetriesPerRequest: null,
        },
        concurrency: this.options.concurrency,
      },
    );
    this.worker.on('ready', () =>
      this.logger.log({
        event: 'worker.ready',
        queue: this.options.queueName,
      }),
    );
    this.worker.on('failed', (job, error) => {
      void this.handleJobFailed(job, error);
    });
    this.worker.on('error', (error) =>
      this.logger.error({
        event: 'worker.connection.error',
        error: error.message,
      }),
    );
  }

  /**
   * Bounded shutdown. Stops taking new jobs, lets running attempts finish for
   * the grace period, then cancels them (which terminates FFmpeg and aborts
   * transfers) and waits for them to settle. Work that still ignores
   * cancellation after that is abandoned: the worker is force-closed so the
   * process can exit, and its attempt lease expires for recovery.
   */
  async onApplicationShutdown(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    await this.bounded(worker.pause(true), this.options.closeTimeoutMs);
    let settled = await this.activeSettledWithin(this.options.shutdownGraceMs);
    if (!settled) {
      this.logger.warn({
        event: 'worker.shutdown.cancelling_attempts',
        activeAttempts: this.active.size,
      });
      this.shutdown.abort(new WorkerShutdownError());
      settled = await this.activeSettledWithin(this.options.settleTimeoutMs);
    }
    if (!settled) {
      this.logger.error({
        event: 'worker.shutdown.abandoned_attempts',
        activeAttempts: this.active.size,
      });
    }
    await this.bounded(worker.close(!settled), this.options.closeTimeoutMs);
  }

  private async activeSettledWithin(ms: number): Promise<boolean> {
    if (this.active.size === 0) return true;
    return this.bounded(
      Promise.allSettled([...this.active]).then(() => true as const),
      ms,
    ).then((result) => result === true);
  }

  /** Resolves with the promise's value, or undefined after `ms`; never rejects. */
  private bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          this.logger.warn({
            event: 'worker.shutdown.step_failed',
            error: error instanceof Error ? error.message : String(error),
          });
          resolve(undefined);
        },
      );
    });
  }

  async checkReady(): Promise<void> {
    if (!this.worker || !this.worker.isRunning())
      throw new Error('BullMQ worker is not running');
    await this.worker.waitUntilReady();
  }

  /**
   * Logs every BullMQ failure. A terminal one (retries exhausted, or a stall
   * that BullMQ failed without running `process()`'s error handling) also moves
   * the generation to a recoverable FAILED state, unless a live lease shows a
   * worker is still active.
   */
  private async handleJobFailed(
    job: Job<ProcessVideoJob> | undefined,
    error: Error,
  ): Promise<void> {
    this.logger.error({
      event: 'video.processing.bull_job_failed',
      videoId: job?.data.videoId,
      jobId: job?.id,
      generation: job?.data.generation,
      correlationId: job?.data.correlationId,
      bullAttempt: job?.attemptsMade,
      error: error.message,
    });
    if (!job) return;
    const terminal =
      job.attemptsMade >= (job.opts.attempts ?? 1) ||
      /stalled/i.test(error.message);
    if (!terminal) return;
    try {
      const recorded = await this.pipeline.failStranded(
        job.data.videoId,
        job.data.generation,
        'Video processing stopped unexpectedly. Retry it.',
      );
      if (recorded) {
        this.logger.error({
          event: 'video.processing.stranded_failed',
          videoId: job.data.videoId,
          jobId: job.id,
          generation: job.data.generation,
          correlationId: job.data.correlationId,
        });
      }
    } catch (recordError) {
      this.logger.error({
        event: 'video.processing.failure_record_failed',
        videoId: job.data.videoId,
        jobId: job.id,
        generation: job.data.generation,
        correlationId: job.data.correlationId,
        error:
          recordError instanceof Error
            ? recordError.message
            : String(recordError),
      });
    }
  }

  /** Tracks the execution so shutdown can wait for it, and free the slot. */
  private process(job: Job<ProcessVideoJob>): Promise<void> {
    const running = this.runJob(job);
    this.active.add(running);
    const forget = () => this.active.delete(running);
    running.then(forget, forget);
    return running;
  }

  private async runJob(job: Job<ProcessVideoJob>): Promise<void> {
    const input = processVideoJobSchema.parse(job.data);
    const startedAt = performance.now();
    this.logger.log({
      event: 'video.processing.job_received',
      videoId: input.videoId,
      jobId: job.id,
      generation: input.generation,
      bullAttempt: job.attemptsMade + 1,
      correlationId: input.correlationId,
    });
    try {
      await this.pipeline.execute(
        job.id ?? 'unknown',
        input,
        job.attemptsMade + 1,
        this.shutdown.signal,
      );
      this.logger.log({
        event: 'video.processing.completed',
        videoId: input.videoId,
        jobId: job.id,
        generation: input.generation,
        bullAttempt: job.attemptsMade + 1,
        correlationId: input.correlationId,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    } catch (error) {
      const processingError = asProcessingError(error);
      const attempts = job.opts.attempts ?? 1;
      const exhausted = job.attemptsMade + 1 >= attempts;
      if (!processingError.retryable) job.discard();
      const attempt = processingError.attemptId
        ? {
            videoId: input.videoId,
            generation: input.generation,
            attemptId: processingError.attemptId,
          }
        : undefined;
      if (attempt) {
        try {
          if (!processingError.retryable || exhausted) {
            // Fenced by attempt identity: a superseded attempt records nothing.
            const recorded = await this.pipeline.fail(
              attempt,
              processingError.publicReason,
            );
            if (recorded) {
              this.logger.error({
                event: 'video.processing.failed',
                videoId: input.videoId,
                jobId: job.id,
                generation: input.generation,
                attemptId: attempt.attemptId,
                bullAttempt: job.attemptsMade + 1,
                correlationId: input.correlationId,
                durationMs:
                  Math.round((performance.now() - startedAt) * 100) / 100,
                reason: processingError.publicReason,
              });
            }
          } else {
            await this.pipeline.release(attempt);
          }
        } catch (recordError) {
          // The BullMQ failure below still surfaces; reconciliation recovers
          // generations whose terminal state could not be recorded here.
          this.logger.error({
            event: 'video.processing.failure_record_failed',
            videoId: input.videoId,
            jobId: job.id,
            generation: input.generation,
            attemptId: attempt.attemptId,
            correlationId: input.correlationId,
            error:
              recordError instanceof Error
                ? recordError.message
                : String(recordError),
          });
        }
      }
      this.logger.warn({
        event: 'video.processing.attempt_failed',
        videoId: input.videoId,
        jobId: job.id,
        generation: input.generation,
        correlationId: input.correlationId,
        bullAttempt: job.attemptsMade + 1,
        attempts,
        retryable: processingError.retryable,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error: processingError.message,
      });
      throw processingError;
    }
  }
}

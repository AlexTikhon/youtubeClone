import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { asProcessingError } from './processing-error.js';

@Injectable()
export class VideoWorkerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(VideoWorkerService.name);
  private worker?: Worker<ProcessVideoJob>;

  constructor(
    @Inject(VideoProcessingPipeline)
    private readonly pipeline: VideoProcessingPipeline,
  ) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<ProcessVideoJob>(
      VIDEO_PROCESSING_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: {
          url: workerEnvironment.REDIS_URL,
          maxRetriesPerRequest: null,
        },
        concurrency: workerEnvironment.WORKER_CONCURRENCY,
      },
    );
    this.worker.on('ready', () =>
      this.logger.log({
        event: 'worker.ready',
        queue: VIDEO_PROCESSING_QUEUE_NAME,
      }),
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error({
        event: 'video.processing.bull_job_failed',
        videoId: job?.data.videoId,
        jobId: job?.id,
        generation: job?.data.generation,
        correlationId: job?.data.correlationId,
        bullAttempt: job?.attemptsMade,
        error: error.message,
      }),
    );
    this.worker.on('error', (error) =>
      this.logger.error({
        event: 'worker.connection.error',
        error: error.message,
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  async checkReady(): Promise<void> {
    if (!this.worker || !this.worker.isRunning())
      throw new Error('BullMQ worker is not running');
    await this.worker.waitUntilReady();
  }

  private async process(job: Job<ProcessVideoJob>): Promise<void> {
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
      if (!processingError.retryable || exhausted) {
        const recorded = await this.pipeline.fail(
          input.videoId,
          input.generation,
          processingError.publicReason,
        );
        if (recorded) {
          this.logger.error({
            event: 'video.processing.failed',
            videoId: input.videoId,
            jobId: job.id,
            generation: input.generation,
            bullAttempt: job.attemptsMade + 1,
            correlationId: input.correlationId,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
            reason: processingError.publicReason,
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

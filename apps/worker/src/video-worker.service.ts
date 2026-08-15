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
        event: 'video.processing.failed',
        videoId: job?.data.videoId,
        jobId: job?.id,
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
    await this.pipeline.close();
  }

  private async process(job: Job<ProcessVideoJob>): Promise<void> {
    const input = processVideoJobSchema.parse(job.data);
    this.logger.log({
      event: 'video.processing.received',
      videoId: input.videoId,
      jobId: job.id,
      correlationId: input.correlationId,
    });
    await this.pipeline.execute(job.id ?? 'unknown', input);
  }
}

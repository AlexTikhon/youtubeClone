import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';

import type { ApiEnvironment } from '@youtube-clone/config';
import {
  VIDEO_PROCESSING_QUEUE_NAME,
  type ProcessVideoJob,
} from '@youtube-clone/types';

import { API_ENVIRONMENT } from '../../config/config.module.js';
import type { VideoProcessingQueue } from './video-processing-queue.port.js';

@Injectable()
export class BullVideoProcessingQueueAdapter
  implements VideoProcessingQueue, OnApplicationShutdown
{
  private readonly queue: Queue<ProcessVideoJob>;

  constructor(@Inject(API_ENVIRONMENT) environment: ApiEnvironment) {
    this.queue = new Queue(VIDEO_PROCESSING_QUEUE_NAME, {
      connection: { url: environment.REDIS_URL },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }

  async enqueue(job: ProcessVideoJob): Promise<void> {
    await this.queue.add('process-video', job, {
      jobId: `video-${job.videoId}`,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}

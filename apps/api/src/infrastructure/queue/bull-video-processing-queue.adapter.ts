import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';

import type { ApiEnvironment } from '@youtube-clone/config';
import {
  VIDEO_PROCESSING_QUEUE_NAME,
  type ProcessVideoJob,
} from '@youtube-clone/types';

import { API_ENVIRONMENT } from '../../config/config.module.js';
import type {
  ProcessingJobRef,
  ProcessingJobState,
  VideoProcessingQueue,
} from './video-processing-queue.port.js';
import { processingJobId } from './video-processing-queue.port.js';

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
      jobId: processingJobId(job),
    });
  }

  async getState(ref: ProcessingJobRef): Promise<ProcessingJobState> {
    const job = await this.queue.getJob(processingJobId(ref));
    if (!job) return 'missing';
    const state = await job.getState();
    if (state === 'completed' || state === 'failed' || state === 'active')
      return state;
    // BullMQ reports 'unknown' when the job hash exists but is in no list.
    return state === 'unknown' ? 'missing' : 'queued';
  }

  async requeue(job: ProcessVideoJob): Promise<void> {
    const retained = await this.queue.getJob(processingJobId(job));
    if (retained) {
      const state = await retained.getState();
      // Only a finished (or orphaned) job may be replaced; live work is left alone.
      if (state !== 'completed' && state !== 'failed' && state !== 'unknown')
        return;
      await retained.remove();
    }
    await this.enqueue(job);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}

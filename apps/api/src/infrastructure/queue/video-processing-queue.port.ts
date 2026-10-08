import type { ProcessVideoJob } from '@youtube-clone/types';

export const VIDEO_PROCESSING_QUEUE = Symbol('VIDEO_PROCESSING_QUEUE');

/**
 * Where a generation's queue job stands. Redis is disposable, so 'missing' is a
 * normal outcome that PostgreSQL state must be able to recover from.
 */
export type ProcessingJobState =
  'missing' | 'queued' | 'active' | 'failed' | 'completed';

export type ProcessingJobRef = Pick<ProcessVideoJob, 'videoId' | 'generation'>;

export interface VideoProcessingQueue {
  /** Idempotent: an existing job with the deterministic ID is left alone. */
  enqueue(job: ProcessVideoJob): Promise<void>;
  getState(ref: ProcessingJobRef): Promise<ProcessingJobState>;
  /**
   * Publishes the generation again even when BullMQ retains a finished job under
   * the deterministic ID, which a plain add would silently ignore.
   */
  requeue(job: ProcessVideoJob): Promise<void>;
}

export function processingJobId(job: ProcessingJobRef): string {
  return `video-${job.videoId}-generation-${job.generation}`;
}

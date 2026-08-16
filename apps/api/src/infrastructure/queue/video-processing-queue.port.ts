import type { ProcessVideoJob } from '@youtube-clone/types';

export const VIDEO_PROCESSING_QUEUE = Symbol('VIDEO_PROCESSING_QUEUE');

export interface VideoProcessingQueue {
  enqueue(job: ProcessVideoJob): Promise<void>;
}

export function processingJobId(
  job: Pick<ProcessVideoJob, 'videoId' | 'generation'>,
): string {
  return `video-${job.videoId}-generation-${job.generation}`;
}

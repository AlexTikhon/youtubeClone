import type { ProcessVideoJob } from '@youtube-clone/types';

export const VIDEO_PROCESSING_QUEUE = Symbol('VIDEO_PROCESSING_QUEUE');

export interface VideoProcessingQueue {
  enqueue(job: ProcessVideoJob): Promise<void>;
}

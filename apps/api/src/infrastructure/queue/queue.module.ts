import { Global, Module } from '@nestjs/common';

import { BullVideoProcessingQueueAdapter } from './bull-video-processing-queue.adapter.js';
import { VIDEO_PROCESSING_QUEUE } from './video-processing-queue.port.js';
import { ProcessingOutboxPublisher } from './processing-outbox.publisher.js';
import { ProcessingReconciler } from './processing-reconciler.js';

@Global()
@Module({
  providers: [
    BullVideoProcessingQueueAdapter,
    ProcessingOutboxPublisher,
    ProcessingReconciler,
    {
      provide: VIDEO_PROCESSING_QUEUE,
      useExisting: BullVideoProcessingQueueAdapter,
    },
  ],
  exports: [
    VIDEO_PROCESSING_QUEUE,
    ProcessingOutboxPublisher,
    ProcessingReconciler,
  ],
})
export class QueueModule {}

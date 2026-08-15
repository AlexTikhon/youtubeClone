import { Global, Module } from '@nestjs/common';

import { BullVideoProcessingQueueAdapter } from './bull-video-processing-queue.adapter.js';
import { VIDEO_PROCESSING_QUEUE } from './video-processing-queue.port.js';

@Global()
@Module({
  providers: [
    BullVideoProcessingQueueAdapter,
    {
      provide: VIDEO_PROCESSING_QUEUE,
      useExisting: BullVideoProcessingQueueAdapter,
    },
  ],
  exports: [VIDEO_PROCESSING_QUEUE],
})
export class QueueModule {}

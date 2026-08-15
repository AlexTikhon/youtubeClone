import { Module } from '@nestjs/common';

import { VideoProcessingPipeline } from './video-processing.pipeline.js';
import { VideoWorkerService } from './video-worker.service.js';
import { DatabaseService } from './database.service.js';
import { MediaToolsService } from './media-tools.service.js';
import { StorageService } from './storage.service.js';

@Module({
  providers: [
    DatabaseService,
    StorageService,
    MediaToolsService,
    VideoProcessingPipeline,
    VideoWorkerService,
  ],
})
export class WorkerModule {}

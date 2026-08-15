import { Module } from '@nestjs/common';

import { VideoProcessingPipeline } from './video-processing.pipeline.js';
import { VideoWorkerService } from './video-worker.service.js';

@Module({ providers: [VideoProcessingPipeline, VideoWorkerService] })
export class WorkerModule {}

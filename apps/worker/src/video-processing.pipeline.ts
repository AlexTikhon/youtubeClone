import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import type { ProcessVideoJob } from '@youtube-clone/types';

@Injectable()
export class VideoProcessingPipeline {
  private readonly logger = new Logger(VideoProcessingPipeline.name);
  private readonly prisma = new PrismaClient();

  async execute(jobId: string, input: ProcessVideoJob): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: input.videoId },
      include: {
        assets: { where: { id: input.originalAssetId, kind: 'ORIGINAL' } },
      },
    });
    if (!video || video.assets.length !== 1)
      throw new Error('Video or original asset was not found');

    // Phase 0 deliberately stops before invoking FFmpeg. Keeping the video in
    // UPLOADED makes the future pipeline safely retryable without pretending it
    // produced playable artifacts.
    this.logger.log({
      event: 'video.processing.deferred',
      videoId: input.videoId,
      jobId,
      correlationId: input.correlationId,
      reason: 'FFmpeg pipeline is scheduled for Phase 1',
    });
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

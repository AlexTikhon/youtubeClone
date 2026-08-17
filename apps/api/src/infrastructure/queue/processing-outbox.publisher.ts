import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

import { PrismaService } from '../database/prisma.service.js';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingQueue,
} from './video-processing-queue.port.js';

const PUBLISH_INTERVAL_MS = 1_000;
const PUBLISH_BATCH_SIZE = 20;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const PUBLISHED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

@Injectable()
export class ProcessingOutboxPublisher
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ProcessingOutboxPublisher.name);
  private timer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private publishing = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(VIDEO_PROCESSING_QUEUE)
    private readonly queue: VideoProcessingQueue,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(
      () => void this.publishPending(),
      PUBLISH_INTERVAL_MS,
    );
    this.timer.unref();
    this.cleanupTimer = setInterval(
      () => void this.cleanupPublished(),
      CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref();
    void this.publishPending();
    void this.cleanupPublished();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  async cleanupPublished(now = new Date()): Promise<void> {
    try {
      const result = await this.prisma.processingOutbox.deleteMany({
        where: {
          publishedAt: {
            lt: new Date(now.getTime() - PUBLISHED_RETENTION_MS),
          },
        },
      });
      if (result.count > 0) {
        this.logger.log({
          event: 'video.processing.outbox_cleaned',
          deletedCount: result.count,
        });
      }
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.outbox_cleanup_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async publishPending(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    try {
      const events = await this.prisma.processingOutbox.findMany({
        where: { publishedAt: null },
        orderBy: { createdAt: 'asc' },
        take: PUBLISH_BATCH_SIZE,
      });
      for (const event of events) {
        try {
          await this.queue.enqueue({
            schemaVersion: 1,
            videoId: event.videoId,
            originalAssetId: event.originalAssetId,
            generation: event.generation,
            correlationId: event.correlationId,
          });
          await this.prisma.processingOutbox.updateMany({
            where: { id: event.id, publishedAt: null },
            data: {
              publishedAt: new Date(),
              attempts: { increment: 1 },
              lastError: null,
            },
          });
          this.logger.log({
            event: 'video.processing.queued',
            videoId: event.videoId,
            generation: event.generation,
            correlationId: event.correlationId,
          });
        } catch (error) {
          await this.prisma.processingOutbox
            .updateMany({
              where: { id: event.id, publishedAt: null },
              data: {
                attempts: { increment: 1 },
                lastError: 'Queue publication failed; the publisher will retry',
              },
            })
            .catch((persistenceError: unknown) =>
              this.logger.warn({
                event: 'video.processing.outbox_update_failed',
                videoId: event.videoId,
                generation: event.generation,
                error:
                  persistenceError instanceof Error
                    ? persistenceError.message
                    : String(persistenceError),
              }),
            );
          this.logger.warn({
            event: 'video.processing.queue_publish_failed',
            videoId: event.videoId,
            generation: event.generation,
            correlationId: event.correlationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.warn({
        event: 'video.processing.outbox_scan_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.publishing = false;
    }
  }
}

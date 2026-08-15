import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';

import { ConfigurationModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { RequestIdMiddleware } from './infrastructure/http/request-id.middleware.js';
import { QueueModule } from './infrastructure/queue/queue.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { StorageModule } from './infrastructure/storage/storage.module.js';
import { VideosModule } from './videos/videos.module.js';
import { AuthModule } from './auth/auth.module.js';

@Module({
  imports: [
    ConfigurationModule,
    AuthModule,
    DatabaseModule,
    RedisModule,
    StorageModule,
    QueueModule,
    HealthModule,
    VideosModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}

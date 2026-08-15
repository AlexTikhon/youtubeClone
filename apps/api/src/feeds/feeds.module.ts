import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { VideosModule } from '../videos/videos.module.js';
import { FeedsController } from './feeds.controller.js';
import { FeedsService } from './feeds.service.js';
@Module({
  imports: [AuthModule, VideosModule],
  controllers: [FeedsController],
  providers: [FeedsService],
})
export class FeedsModule {}

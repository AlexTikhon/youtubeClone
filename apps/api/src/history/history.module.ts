import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { VideosModule } from '../videos/videos.module.js';
import { HistoryController } from './history.controller.js';
import { HistoryService } from './history.service.js';
@Module({
  imports: [AuthModule, VideosModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { VideosModule } from '../videos/videos.module.js';
import { ChannelsController } from './channels.controller.js';
import { ChannelsService } from './channels.service.js';
@Module({
  imports: [AuthModule, VideosModule],
  controllers: [ChannelsController],
  providers: [ChannelsService],
})
export class ChannelsModule {}

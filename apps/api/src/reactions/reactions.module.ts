import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { VideosModule } from '../videos/videos.module.js';
import { ReactionsController } from './reactions.controller.js';
import { ReactionsService } from './reactions.service.js';

@Module({
  imports: [AuthModule, VideosModule],
  controllers: [ReactionsController],
  providers: [ReactionsService],
})
export class ReactionsModule {}

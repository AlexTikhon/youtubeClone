import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { VideosController } from './videos.controller.js';
import { MediaController } from './media.controller.js';
import { VideosService } from './videos.service.js';

@Module({
  imports: [AuthModule],
  controllers: [VideosController, MediaController],
  providers: [VideosService, UploadsService],
})
export class VideosModule {}

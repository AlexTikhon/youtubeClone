import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { VideosController } from './videos.controller.js';
import { VideosService } from './videos.service.js';

@Module({
  imports: [AuthModule],
  controllers: [VideosController],
  providers: [VideosService, UploadsService],
})
export class VideosModule {}

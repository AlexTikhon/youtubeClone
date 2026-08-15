import { Module } from '@nestjs/common';

import { SessionAuthService } from './session-auth.service.js';
import { SessionGuard } from './session.guard.js';
import { OptionalSessionGuard } from './optional-session.guard.js';
import { AuthController } from './auth.controller.js';

@Module({
  controllers: [AuthController],
  providers: [SessionAuthService, SessionGuard, OptionalSessionGuard],
  exports: [SessionAuthService, SessionGuard, OptionalSessionGuard],
})
export class AuthModule {}

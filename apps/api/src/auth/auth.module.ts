import { Module } from '@nestjs/common';

import { SessionAuthService } from './session-auth.service.js';
import { SessionGuard } from './session.guard.js';

@Module({
  providers: [SessionAuthService, SessionGuard],
  exports: [SessionAuthService, SessionGuard],
})
export class AuthModule {}

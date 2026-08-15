import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import type { ApiEnvironment } from '@youtube-clone/config';

import { API_ENVIRONMENT } from '../config/config.module.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { readCookie } from './cookie.js';
import { SessionAuthService } from './session-auth.service.js';

@Injectable()
export class OptionalSessionGuard implements CanActivate {
  constructor(
    @Inject(SessionAuthService) private readonly sessions: SessionAuthService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const token = readCookie(
      request.header('cookie'),
      this.environment.SESSION_COOKIE_NAME,
    );
    if (token)
      request.user = (await this.sessions.authenticate(token)) ?? undefined;
    return true;
  }
}

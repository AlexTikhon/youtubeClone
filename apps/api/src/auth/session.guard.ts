import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import type { ApiEnvironment } from '@youtube-clone/config';

import { API_ENVIRONMENT } from '../config/config.module.js';
import { AppError } from '../infrastructure/http/app-error.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { readCookie } from './cookie.js';
import { SessionAuthService } from './session-auth.service.js';

@Injectable()
export class SessionGuard implements CanActivate {
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
    if (!token)
      throw new AppError('AUTH_REQUIRED', 'Authentication is required', 401);
    const user = await this.sessions.authenticate(token);
    if (!user)
      throw new AppError(
        'SESSION_INVALID',
        'The session is invalid or expired',
        401,
      );
    request.user = user;
    return true;
  }
}

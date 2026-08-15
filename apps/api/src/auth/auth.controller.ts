import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import type { ApiEnvironment } from '@youtube-clone/config';
import type { AuthenticatedUserResponse } from '@youtube-clone/types';
import { loginSchema, type LoginInput } from '@youtube-clone/validation';

import { API_ENVIRONMENT } from '../config/config.module.js';
import { AppError } from '../infrastructure/http/app-error.js';
import type { RequestWithContext } from '../infrastructure/http/request-context.js';
import { ZodBodyPipe } from '../infrastructure/http/zod-body.pipe.js';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedUser } from './auth.types.js';
import { readCookie } from './cookie.js';
import { SessionAuthService } from './session-auth.service.js';
import { SessionGuard } from './session.guard.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(SessionAuthService) private readonly sessions: SessionAuthService,
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {}

  @Post('login')
  async login(
    @Body(new ZodBodyPipe(loginSchema)) input: LoginInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticatedUserResponse> {
    try {
      const result = await this.sessions.login(
        input.email,
        input.password,
        this.environment.SESSION_TTL_SECONDS,
      );
      response.cookie(this.environment.SESSION_COOKIE_NAME, result.token, {
        httpOnly: true,
        secure: this.environment.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: this.environment.SESSION_TTL_SECONDS * 1000,
      });
      return result.user;
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_CREDENTIALS') {
        throw new AppError(
          'INVALID_CREDENTIALS',
          'Email or password is incorrect',
          401,
        );
      }
      throw error;
    }
  }

  @Post('logout')
  async logout(
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: true }> {
    const token = readCookie(
      request.header('cookie'),
      this.environment.SESSION_COOKIE_NAME,
    );
    if (token) await this.sessions.revoke(token);
    response.clearCookie(this.environment.SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: this.environment.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
    return { success: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUserResponse {
    return user;
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RedisService } from '../redis/redis.service.js';
import { AppError } from './app-error.js';
import {
  RATE_LIMIT_METADATA,
  type RateLimitPolicy,
} from './rate-limit.decorator.js';
import type { RequestWithContext } from './request-context.js';

const INCREMENT_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.get<RateLimitPolicy>(
      RATE_LIMIT_METADATA,
      context.getHandler(),
    );
    if (!policy) return true;
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const identity = request.user?.id ?? request.ip ?? 'unknown';
    const window = Math.floor(Date.now() / (policy.windowSeconds * 1000));
    const key = `rate:${policy.scope}:${identity}:${window}`;
    try {
      const count = Number(
        await this.redis.client.eval(
          INCREMENT_WINDOW,
          1,
          key,
          policy.windowSeconds,
        ),
      );
      if (count > policy.limit) {
        throw new AppError(
          'RATE_LIMITED',
          'Too many requests. Please try again shortly.',
          429,
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.logger.warn({
        event: 'rate_limit.unavailable',
        scope: policy.scope,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
}

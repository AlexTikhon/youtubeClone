import { Global, Module } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard.js';

@Global()
@Module({ providers: [RateLimitGuard], exports: [RateLimitGuard] })
export class HttpInfrastructureModule {}

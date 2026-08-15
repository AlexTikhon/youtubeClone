import { Controller, Get, HttpCode, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

import type { HealthDependency, HealthResponse } from '@youtube-clone/types';

import { PrismaService } from '../infrastructure/database/prisma.service.js';
import { AppError } from '../infrastructure/http/app-error.js';
import { RedisService } from '../infrastructure/redis/redis.service.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Process liveness' })
  live(): HealthResponse {
    return {
      status: 'ok',
      service: 'api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @HttpCode(200)
  @ApiOperation({ summary: 'PostgreSQL and Redis readiness' })
  async ready(): Promise<HealthResponse> {
    const [postgres, redis] = await Promise.all([
      this.check(() => this.prisma.$queryRaw(Prisma.sql`SELECT 1`)),
      this.check(() => this.redis.ping()),
    ]);
    const response: HealthResponse = {
      status:
        postgres.status === 'up' && redis.status === 'up' ? 'ok' : 'degraded',
      service: 'api',
      timestamp: new Date().toISOString(),
      dependencies: { postgres, redis },
    };
    if (response.status === 'degraded') {
      throw new AppError(
        'SERVICE_NOT_READY',
        'One or more required dependencies are unavailable',
        503,
        response.dependencies,
      );
    }
    return response;
  }

  private async check(
    operation: () => Promise<unknown>,
  ): Promise<HealthDependency> {
    const startedAt = performance.now();
    try {
      await Promise.race([
        operation(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Health check timed out')), 5_000),
        ),
      ]);
      return {
        status: 'up',
        latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
      };
    } catch {
      return { status: 'down' };
    }
  }
}

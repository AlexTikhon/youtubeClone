import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { workerEnvironment } from './config.js';
import { DatabaseService } from './database.service.js';
import { MediaToolsService } from './media-tools.service.js';
import { StorageService } from './storage.service.js';
import { VideoWorkerService } from './video-worker.service.js';

type Dependency = { status: 'up'; latencyMs: number } | { status: 'down' };

@Injectable()
export class WorkerHealthService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerHealthService.name);
  private server?: Server;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(VideoWorkerService) private readonly worker: VideoWorkerService,
    @Inject(MediaToolsService) private readonly mediaTools: MediaToolsService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  onApplicationBootstrap(): void {
    this.server = createServer((request, response) => {
      if (request.method !== 'GET') {
        this.respond(response, 405, { error: 'Method not allowed' });
        return;
      }
      if (request.url === '/health/live') {
        this.respond(response, 200, this.response('ok'));
        return;
      }
      if (request.url === '/health/ready') {
        void this.readiness().then(({ ready, body }) =>
          this.respond(response, ready ? 200 : 503, body),
        );
        return;
      }
      this.respond(response, 404, { error: 'Not found' });
    });
    this.server.listen(workerEnvironment.WORKER_HEALTH_PORT, '0.0.0.0', () =>
      this.logger.log({
        event: 'worker.health.listening',
        port: workerEnvironment.WORKER_HEALTH_PORT,
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async readiness(): Promise<{
    ready: boolean;
    body: Record<string, unknown>;
  }> {
    const [postgres, redis, objectStorage, mediaTools] = await Promise.all([
      this.check(() => this.database.$queryRaw(Prisma.sql`SELECT 1`)),
      this.check(() => this.worker.checkReady()),
      this.check(() => this.storage.checkReady()),
      this.check(() => this.mediaTools.checkReady()),
    ]);
    const dependencies = { postgres, redis, objectStorage, mediaTools };
    const ready = Object.values(dependencies).every(
      (dependency) => dependency.status === 'up',
    );
    return {
      ready,
      body: this.response(ready ? 'ok' : 'degraded', dependencies),
    };
  }

  private async check(operation: () => Promise<unknown>): Promise<Dependency> {
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

  private response(
    status: 'ok' | 'degraded',
    dependencies?: Record<string, Dependency>,
  ): Record<string, unknown> {
    return {
      status,
      service: 'worker',
      timestamp: new Date().toISOString(),
      ...(dependencies ? { dependencies } : {}),
    };
  }

  private respond(
    response: ServerResponse,
    statusCode: number,
    body: Record<string, unknown>,
  ): void {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
}

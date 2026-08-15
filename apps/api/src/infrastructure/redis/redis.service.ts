import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import type { ApiEnvironment } from '@youtube-clone/config';

import { API_ENVIRONMENT } from '../../config/config.module.js';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly client: Redis;

  constructor(@Inject(API_ENVIRONMENT) environment: ApiEnvironment) {
    this.client = new Redis(environment.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<string> {
    if (this.client.status === 'wait') await this.client.connect();
    return this.client.ping();
  }

  onApplicationShutdown(): void {
    if (this.client.status !== 'end') this.client.disconnect();
  }
}

import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const prisma = enabled ? new PrismaClient() : null;
const redis =
  enabled && process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

describe.skipIf(!enabled)('infrastructure integration', () => {
  afterAll(async () => {
    await prisma?.$disconnect();
    redis?.disconnect();
  });

  it('can reach PostgreSQL and Redis', async () => {
    if (!prisma || !redis)
      throw new Error('Integration clients were not configured');
    await expect(prisma.$queryRaw`SELECT 1`).resolves.toBeDefined();
    await expect(redis.ping()).resolves.toBe('PONG');
  });
});

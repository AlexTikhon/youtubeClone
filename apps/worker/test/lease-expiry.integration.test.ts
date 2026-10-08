import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acquireAttempt, renewAttempt } from '../src/processing-lease.js';
import {
  cleanupFixtures,
  createPipeline,
  createUploadedVideo,
  expireLease,
  generatedKeys,
  prisma,
  sleep,
} from './attempt-support.js';

/** Real PostgreSQL: lease expiry is enforced by the database clock. */
describe('lease expiry enforcement', () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  it('does not resurrect an expired lease even when no other attempt took over', async () => {
    const { videoId } = await createUploadedVideo();
    const attemptId = (await acquireAttempt(prisma as never, {
      videoId,
      generation: 1,
      leaseSeconds: 30,
    }))!;
    const attempt = { videoId, generation: 1, attemptId };
    await expect(renewAttempt(prisma as never, attempt, 30)).resolves.toBe(
      true,
    );

    await expireLease(videoId);
    const expired = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
    });

    await expect(renewAttempt(prisma as never, attempt, 30)).resolves.toBe(
      false,
    );
    const after = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
    });
    expect(after.processingLeaseExpiresAt).toEqual(
      expired.processingLeaseExpiresAt,
    );
    expect(after.processingAttemptId).toBe(attemptId);
  });

  /**
   * Runs `beforeCommit` right before the pipeline's publication transaction
   * starts, i.e. after the pipeline's last ownership check.
   */
  function racingDatabase(beforeCommit: () => Promise<void>) {
    return new Proxy(prisma, {
      get(target, property) {
        if (property === '$transaction') {
          return async (...args: unknown[]) => {
            await beforeCommit();
            return (target.$transaction as (...input: unknown[]) => unknown)(
              ...args,
            );
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PrismaClient;
  }

  async function expectNothingPublished(videoId: string, attemptId?: string) {
    const after = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      include: { assets: true },
    });
    expect(after.status).toBe('PROCESSING');
    expect(after.committedAttemptId).toBeNull();
    if (attemptId) expect(after.processingAttemptId).toBe(attemptId);
    expect(after.assets.map((asset) => asset.kind)).toEqual(['ORIGINAL']);
    expect(await generatedKeys(videoId)).toEqual([]);
  }

  it('refuses READY when the lease expires after the last ownership check, without a takeover', async () => {
    const { videoId, job } = await createUploadedVideo();
    const database = racingDatabase(() => expireLease(videoId));

    const rejected = createPipeline({}, undefined, undefined, database)
      .execute('expiry-job', job)
      .catch((error: unknown) => error);

    // Retryable and attributed to the attempt: the worker service releases it.
    await expect(rejected).resolves.toMatchObject({
      name: 'AttemptLeaseExpiredError',
      retryable: true,
      attemptId: expect.any(String),
    });
    const row = await prisma.video.findUniqueOrThrow({
      where: { id: videoId },
    });
    await expectNothingPublished(videoId, row.processingAttemptId!);
  });

  it('refuses READY when the lease expires while the publication waits for the row lock', async () => {
    const { videoId, job } = await createUploadedVideo();
    // The lock holder needs its own connection pool, and the pipeline's
    // transaction a warm second connection, or the wait never happens.
    const holderClient = new PrismaClient();
    await Promise.all([
      holderClient.$queryRaw`SELECT 1`,
      prisma.$executeRaw`SELECT pg_sleep(0.2)`,
      prisma.$executeRaw`SELECT pg_sleep(0.2)`,
    ]);
    let holder: Promise<void> | undefined;
    const database = racingDatabase(async () => {
      // Valid when publication starts, expired 800 ms later.
      await prisma.$executeRaw`
        UPDATE "Video"
        SET "processingLeaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '800 milliseconds'
        WHERE id = ${videoId}::uuid`;
      // A plain row lock that writes nothing: only a check evaluated after the
      // lock is granted can notice that the lease ran out while waiting.
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      holder = holderClient.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`SELECT 1 FROM "Video" WHERE id = ${videoId}::uuid FOR UPDATE`;
          locked();
          await sleep(1_500);
        },
        { timeout: 20_000 },
      );
      await holding;
    });

    const outcome = await createPipeline({}, undefined, undefined, database)
      .execute('lock-wait-job', job)
      .catch((error: unknown) => error);
    await holder;
    await holderClient.$disconnect();

    expect(outcome).toMatchObject({
      name: 'AttemptLeaseExpiredError',
      retryable: true,
    });
    await expectNothingPublished(videoId);
  });
});

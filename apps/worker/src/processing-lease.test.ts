import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AttemptDeadlineError,
  AttemptLeaseExpiredError,
  AttemptOwnershipLostError,
  WorkerShutdownError,
} from './processing-error.js';
import { AttemptLease, type LeaseDatabase } from './processing-lease.js';

const attempt = { videoId: 'video', generation: 1, attemptId: 'attempt' };

/** A database whose renewal statement behaves as scripted; tracks overlap. */
function scriptedDatabase(
  behave: (call: number) => Promise<number> | number = () => 1,
) {
  const state = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const executeRaw = (async () => {
    state.calls += 1;
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      return await behave(state.calls);
    } finally {
      state.inFlight -= 1;
    }
  }) as unknown;
  return {
    state,
    database: { $executeRaw: executeRaw } as unknown as LeaseDatabase,
  };
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const leases: AttemptLease[] = [];
function createLease(
  database: LeaseDatabase,
  options: Partial<ConstructorParameters<typeof AttemptLease>[2]> = {},
) {
  const lease = new AttemptLease(database, attempt, {
    leaseSeconds: 30,
    renewIntervalMs: 10_000,
    maxDurationMs: 60_000,
    ...options,
  });
  leases.push(lease);
  return lease;
}

afterEach(() => {
  for (const lease of leases.splice(0)) lease.stop();
});

describe('AttemptLease cancellation lifecycle', () => {
  it('aborts the attempt signal with a typed error when the hard deadline passes', async () => {
    const { database } = scriptedDatabase();
    const lease = createLease(database, { maxDurationMs: 60 });
    lease.start();

    await delay(200);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBeInstanceOf(AttemptDeadlineError);
    await expect(lease.ensureOwned()).rejects.toBeInstanceOf(
      AttemptDeadlineError,
    );
  });

  it('aborts with ownership loss as soon as a renewal reports the lease is gone', async () => {
    const { database, state } = scriptedDatabase(() => 0);
    const lease = createLease(database, { renewIntervalMs: 20 });
    lease.start();

    await delay(150);

    expect(lease.signal.reason).toBeInstanceOf(AttemptOwnershipLostError);
    const callsAtLoss = state.calls;
    await delay(100);
    expect(state.calls).toBe(callsAtLoss); // a lost lease is never retried
  });

  it('aborts when the worker shuts down, including when it already has', async () => {
    const { database } = scriptedDatabase();
    const shutdown = new AbortController();
    const lease = createLease(database, { shutdownSignal: shutdown.signal });
    lease.start();
    shutdown.abort();
    expect(lease.signal.reason).toBeInstanceOf(WorkerShutdownError);

    const late = createLease(database, { shutdownSignal: shutdown.signal });
    late.start();
    expect(late.signal.reason).toBeInstanceOf(WorkerShutdownError);
  });

  it('aborts when renewals keep failing, no later than the lease length it last confirmed', async () => {
    // The first renewal is confirmed; every later one fails (database down).
    const { database } = scriptedDatabase((call) => {
      if (call === 1) return 1;
      throw new Error('database unreachable');
    });
    const lease = createLease(database, {
      leaseSeconds: 0.4,
      renewIntervalMs: 50,
    });
    lease.start();
    const startedAt = performance.now();

    while (!lease.signal.aborted && performance.now() - startedAt < 3_000)
      await delay(20);

    expect(lease.signal.reason).toBeInstanceOf(AttemptLeaseExpiredError);
    // Confirmed ~50 ms in, so validity ends ~450 ms in, never much later.
    expect(performance.now() - startedAt).toBeLessThan(900);
  });

  it('does not let a hung renewal hold ensureOwned past the end of the lease', async () => {
    const { database } = scriptedDatabase(() => new Promise<number>(() => {}));
    const lease = createLease(database, { leaseSeconds: 0.2 });
    lease.start();

    const startedAt = performance.now();
    await expect(lease.ensureOwned()).rejects.toBeInstanceOf(
      AttemptLeaseExpiredError,
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('keeps a healthy lease alive through the hard-deadline-free interval', async () => {
    const { database, state } = scriptedDatabase(() => 1);
    const lease = createLease(database, {
      leaseSeconds: 0.3,
      renewIntervalMs: 40,
    });
    lease.start();

    await delay(700); // more than twice the lease length

    expect(lease.signal.aborted).toBe(false);
    expect(state.calls).toBeGreaterThan(5);
  });
});

describe('AttemptLease renewal serialization', () => {
  it('never runs two renewals at once, even when heartbeat and checks overlap', async () => {
    const { database, state } = scriptedDatabase(async () => {
      await delay(40);
      return 1;
    });
    const lease = createLease(database, { renewIntervalMs: 5 });
    lease.start();

    await Promise.all([
      lease.ensureOwned(),
      lease.ensureOwned(),
      lease.ensureOwned(),
    ]);
    await delay(150);

    expect(state.calls).toBeGreaterThanOrEqual(4);
    expect(state.maxInFlight).toBe(1);
  });

  it('issues no renewal after stop(), including renewals already queued', async () => {
    const release = vi.fn();
    let finishFirst!: () => void;
    const { database, state } = scriptedDatabase((call) =>
      call === 1
        ? new Promise<number>((resolve) => {
            finishFirst = () => {
              release();
              resolve(1);
            };
          })
        : 1,
    );
    const lease = createLease(database, { renewIntervalMs: 10 });
    lease.start();
    const first = lease.ensureOwned().catch(() => undefined);
    const queued = lease.ensureOwned().catch(() => undefined);
    await delay(20);
    expect(state.calls).toBe(1);

    lease.stop();
    finishFirst();
    await Promise.all([first, queued]);
    await delay(100);

    expect(state.calls).toBe(1); // the queued renewal never reached the database
    expect(lease.signal.aborted).toBe(true);
  });
});

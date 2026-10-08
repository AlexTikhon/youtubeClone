import { describe, expect, it, vi } from 'vitest';

import {
  AttemptBusyError,
  AttemptOwnershipLostError,
  ProcessingError,
} from './processing-error.js';
import { VideoWorkerService } from './video-worker.service.js';

const data = {
  schemaVersion: 1,
  videoId: '7b0f7a28-1f0a-4a55-9f44-2c9d5f6a6c11',
  originalAssetId: '4ab9c4e2-3f1b-4c43-8f8c-6d88a8b29a01',
  generation: 1,
  correlationId: 'request-id',
};

function createJob(attemptsMade: number, attempts = 3) {
  return {
    id: 'job-id',
    data,
    attemptsMade,
    opts: { attempts },
    discard: vi.fn(),
  };
}

function createService(pipeline: object) {
  const service = new VideoWorkerService(pipeline as never);
  return (job: ReturnType<typeof createJob>) =>
    (service as unknown as { process(job: unknown): Promise<void> }).process(
      job,
    );
}

function failing(error: ProcessingError, attemptId?: string) {
  error.attemptId = attemptId;
  return error;
}

describe('VideoWorkerService failure recording', () => {
  it('records the final failure for the attempt that produced it', async () => {
    const pipeline = {
      execute: vi
        .fn()
        .mockRejectedValue(
          failing(new ProcessingError('boom', true, 'Safe'), 'attempt-1'),
        ),
      fail: vi.fn().mockResolvedValue(true),
      release: vi.fn(),
    };

    await expect(createService(pipeline)(createJob(2))).rejects.toThrow('boom');

    expect(pipeline.fail).toHaveBeenCalledWith(
      { videoId: data.videoId, generation: 1, attemptId: 'attempt-1' },
      'Safe',
    );
    expect(pipeline.release).not.toHaveBeenCalled();
  });

  it('releases the lease instead of failing while BullMQ retries remain', async () => {
    const pipeline = {
      execute: vi
        .fn()
        .mockRejectedValue(
          failing(new ProcessingError('flaky', true, 'Safe'), 'attempt-1'),
        ),
      fail: vi.fn(),
      release: vi.fn().mockResolvedValue(true),
    };

    await expect(createService(pipeline)(createJob(0))).rejects.toThrow(
      'flaky',
    );

    expect(pipeline.fail).not.toHaveBeenCalled();
    expect(pipeline.release).toHaveBeenCalledWith({
      videoId: data.videoId,
      generation: 1,
      attemptId: 'attempt-1',
    });
  });

  it('never fails the video for an execution that did not acquire an attempt', async () => {
    const pipeline = {
      execute: vi.fn().mockRejectedValue(new AttemptBusyError()),
      fail: vi.fn(),
      release: vi.fn(),
    };

    await expect(createService(pipeline)(createJob(2))).rejects.toBeInstanceOf(
      AttemptBusyError,
    );

    expect(pipeline.fail).not.toHaveBeenCalled();
    expect(pipeline.release).not.toHaveBeenCalled();
  });

  it('discards a superseded attempt and lets the fenced failure be a no-op', async () => {
    const job = createJob(0);
    const pipeline = {
      execute: vi
        .fn()
        .mockRejectedValue(failing(new AttemptOwnershipLostError(), 'loser')),
      fail: vi.fn().mockResolvedValue(false),
      release: vi.fn(),
    };

    await expect(createService(pipeline)(job)).rejects.toBeInstanceOf(
      AttemptOwnershipLostError,
    );

    expect(job.discard).toHaveBeenCalledOnce();
    expect(pipeline.fail).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'loser' }),
      expect.any(String),
    );
  });

  it('surfaces the original error when the failure cannot be recorded', async () => {
    const pipeline = {
      execute: vi
        .fn()
        .mockRejectedValue(
          failing(new ProcessingError('original', false, 'Safe'), 'attempt-1'),
        ),
      fail: vi.fn().mockRejectedValue(new Error('database down')),
      release: vi.fn(),
    };

    await expect(createService(pipeline)(createJob(0))).rejects.toThrow(
      'original',
    );
  });
});

describe('VideoWorkerService terminal BullMQ failures', () => {
  function createListener(pipeline: object) {
    const service = new VideoWorkerService(pipeline as never);
    return (
      job: Record<string, unknown> | undefined,
      error: Error,
    ): Promise<void> =>
      (
        service as unknown as {
          handleJobFailed(job: unknown, error: Error): Promise<void>;
        }
      ).handleJobFailed(job, error);
  }

  it('moves a terminally stalled job to a recoverable database state', async () => {
    const pipeline = { failStranded: vi.fn().mockResolvedValue(true) };

    await createListener(pipeline)(
      { data, attemptsMade: 0, opts: { attempts: 3 } },
      new Error('job stalled more than allowable limit'),
    );

    expect(pipeline.failStranded).toHaveBeenCalledWith(
      data.videoId,
      1,
      expect.any(String),
    );
  });

  it('also covers an exhausted job whose own failure recording did not run', async () => {
    const pipeline = { failStranded: vi.fn().mockResolvedValue(false) };

    await createListener(pipeline)(
      { data, attemptsMade: 3, opts: { attempts: 3 } },
      new Error('anything'),
    );

    expect(pipeline.failStranded).toHaveBeenCalledOnce();
  });

  it('leaves a job with BullMQ retries remaining alone', async () => {
    const pipeline = { failStranded: vi.fn() };

    await createListener(pipeline)(
      { data, attemptsMade: 1, opts: { attempts: 3 } },
      new Error('transient'),
    );

    expect(pipeline.failStranded).not.toHaveBeenCalled();
  });

  it('survives a database outage while recording the failure', async () => {
    const pipeline = {
      failStranded: vi.fn().mockRejectedValue(new Error('database down')),
    };

    await expect(
      createListener(pipeline)(
        { data, attemptsMade: 3, opts: { attempts: 3 } },
        new Error('boom'),
      ),
    ).resolves.toBeUndefined();
  });

  it('ignores a failure event without a job', async () => {
    const pipeline = { failStranded: vi.fn() };

    await createListener(pipeline)(undefined, new Error('boom'));

    expect(pipeline.failStranded).not.toHaveBeenCalled();
  });
});

describe('VideoWorkerService bounded shutdown', () => {
  function shutdownHarness(pipeline: object) {
    const worker = {
      pause: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const service = new VideoWorkerService(pipeline as never, {
      shutdownGraceMs: 80,
      settleTimeoutMs: 150,
      closeTimeoutMs: 100,
    });
    (service as unknown as { worker: typeof worker }).worker = worker;
    const process = (
      service as unknown as {
        process(job: unknown): Promise<void>;
      }
    ).process.bind(service);
    return { service, worker, process };
  }

  /** An execution that, like real I/O, settles only because its signal aborted. */
  function cancellablePipeline() {
    const seen: { signal?: AbortSignal } = {};
    return {
      seen,
      execute: vi.fn(
        (
          _jobId: string,
          _input: unknown,
          _attempt: number,
          signal?: AbortSignal,
        ) => {
          seen.signal = signal;
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () =>
                reject(failing(signal.reason as ProcessingError, 'attempt-1')),
              { once: true },
            );
          });
        },
      ),
      fail: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(true),
    };
  }

  it('lets a job that finishes within the grace period complete uncancelled', async () => {
    const pipeline = {
      execute: vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
      ),
      fail: vi.fn(),
      release: vi.fn(),
    };
    const { service, worker, process } = shutdownHarness(pipeline);
    const running = process(createJob(0));

    await service.onApplicationShutdown();

    await expect(running).resolves.toBeUndefined();
    const signal = pipeline.execute.mock.calls[0]![3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(worker.pause).toHaveBeenCalledWith(true);
    expect(worker.close).toHaveBeenCalledWith(false);
  });

  it('cancels running attempts after the grace period and releases their lease', async () => {
    const pipeline = cancellablePipeline();
    const { service, worker, process } = shutdownHarness(pipeline);
    const running = process(createJob(0)).catch((error: unknown) => error);

    const startedAt = performance.now();
    await service.onApplicationShutdown();

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(70);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(pipeline.seen.signal?.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({
      name: 'WorkerShutdownError',
      retryable: true,
    });
    // Retryable and not exhausted: handed back for immediate retry elsewhere.
    expect(pipeline.release).toHaveBeenCalledWith({
      videoId: data.videoId,
      generation: 1,
      attemptId: 'attempt-1',
    });
    expect(worker.close).toHaveBeenCalledWith(false);
  });

  it('gives up on work that ignores cancellation and force-closes the worker', async () => {
    const pipeline = {
      // Never settles, whatever the signal says: a wedged operation.
      execute: vi.fn(() => new Promise<void>(() => {})),
      fail: vi.fn(),
      release: vi.fn(),
    };
    const { service, worker, process } = shutdownHarness(pipeline);
    void process(createJob(0));
    // A hung close must not hang shutdown either.
    worker.close.mockImplementation(() => new Promise<void>(() => {}));

    const startedAt = performance.now();
    await service.onApplicationShutdown();

    // grace (80) + settle (150) + close (100), with slack for timers.
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(worker.close).toHaveBeenCalledWith(true);
  });
});

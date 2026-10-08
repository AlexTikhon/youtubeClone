import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AttemptDeadlineError, ProcessingError } from './processing-error.js';
import { runProcess } from './run-process.js';

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'youtube-clone-run-process-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = await readFile(file, 'utf8');
      if (text.trim()) return Number(text);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The child process never reported its pid');
}

/** A real child that records its pid, then runs until it is killed. */
function longRunningChild(options: { ignoreSigterm?: boolean } = {}) {
  const pidFile = join(directory, `${randomUUID()}.pid`);
  const script = `
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    ${options.ignoreSigterm ? "process.on('SIGTERM', () => {});" : ''}
    setInterval(() => {}, 1000);
  `;
  return { pidFile, args: ['-e', script] };
}

describe('runProcess', () => {
  it('returns stdout of a successful process', async () => {
    await expect(
      runProcess(process.execPath, ['-e', "process.stdout.write('ok')"], {
        operation: 'echo',
        timeoutMs: 10_000,
      }),
    ).resolves.toBe('ok');
  });

  it('fails with the process stderr when the exit code is not zero', async () => {
    const rejected = runProcess(
      process.execPath,
      ['-e', "console.error('bad input'); process.exit(3)"],
      { operation: 'ffprobe', timeoutMs: 10_000 },
    );
    await expect(rejected).rejects.toMatchObject({
      retryable: false,
      publicReason: 'The uploaded file is not a valid video',
      message: expect.stringContaining('bad input'),
    });
  });

  it('kills and reaps the child when the attempt signal aborts, then rejects with the abort reason', async () => {
    const child = longRunningChild();
    const controller = new AbortController();
    const running = runProcess(process.execPath, child.args, {
      operation: 'transcode',
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const settled = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    const pid = await waitForPid(child.pidFile);
    expect(isAlive(pid)).toBe(true);

    const reason = new AttemptDeadlineError();
    controller.abort(reason);

    await expect(settled).resolves.toBe(reason);
    // The promise settles only after the child is gone, never before.
    expect(isAlive(pid)).toBe(false);
  });

  it('escalates to SIGKILL for a child that ignores the polite termination request', async () => {
    const child = longRunningChild({ ignoreSigterm: true });
    const controller = new AbortController();
    const settled = runProcess(process.execPath, child.args, {
      operation: 'transcode',
      timeoutMs: 60_000,
      signal: controller.signal,
      killGraceMs: 200,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const pid = await waitForPid(child.pidFile);

    controller.abort(new AttemptDeadlineError());

    await expect(settled).resolves.toBeInstanceOf(AttemptDeadlineError);
    expect(isAlive(pid)).toBe(false);
  });

  it('does not start a process when the signal is already aborted', async () => {
    const child = longRunningChild();
    const reason = new AttemptDeadlineError();

    await expect(
      runProcess(process.execPath, child.args, {
        operation: 'transcode',
        timeoutMs: 60_000,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(child.pidFile)).toBe(false);
  });

  it('kills a child that exceeds the per-process timeout and reports a retryable timeout', async () => {
    const child = longRunningChild();
    const rejected = runProcess(process.execPath, child.args, {
      operation: 'transcode',
      timeoutMs: 400,
    });

    await expect(rejected).rejects.toBeInstanceOf(ProcessingError);
    await expect(rejected).rejects.toMatchObject({
      retryable: true,
      publicReason: 'Video processing timed out',
    });
    expect(isAlive(await waitForPid(child.pidFile))).toBe(false);
  });
});

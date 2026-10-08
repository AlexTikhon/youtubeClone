import { spawn } from 'node:child_process';

import { ProcessingError } from './processing-error.js';

export interface RunProcessOptions {
  /** Human-readable name used in errors, e.g. `ffprobe`. */
  operation: string;
  /** Per-process ceiling, independent of the attempt deadline. */
  timeoutMs: number;
  /** Attempt cancellation: the child is terminated and reaped. */
  signal?: AbortSignal;
  /** How long a child gets to exit after the polite request before SIGKILL. */
  killGraceMs?: number;
}

const OUTPUT_TAIL_BYTES = 2_000_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * Runs one external tool and resolves with its stdout. Cancellation is real:
 * aborting the signal (or hitting the timeout) terminates the child, escalates
 * to SIGKILL when it ignores the request, and settles only after the operating
 * system reports the process gone, so a cancelled attempt never leaves FFmpeg
 * running behind it. An abort rejects with `signal.reason`.
 */
export function runProcess(
  executable: string,
  args: string[],
  options: RunProcessOptions,
): Promise<string> {
  const { operation, signal } = options;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let terminated: 'aborted' | 'timeout' | undefined;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: Buffer) =>
      (current + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const terminate = (why: 'aborted' | 'timeout') => {
      if (terminated || settled) return;
      terminated = why;
      if (why === 'timeout') {
        child.kill('SIGKILL');
        return;
      }
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    const onAbort = () => terminate('aborted');
    const timeout = setTimeout(() => terminate('timeout'), options.timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    // After we killed it, 'exit' means the process is gone; waiting for 'close'
    // as well could hang on a pipe inherited by a surviving grandchild.
    child.once('exit', () => {
      if (!terminated) return;
      child.stdout.destroy();
      child.stderr.destroy();
      finish(() =>
        terminated === 'aborted'
          ? reject(signal?.reason)
          : reject(timeoutError(operation)),
      );
    });
    child.once('error', (error) => {
      finish(() =>
        reject(
          new ProcessingError(
            `${operation} could not start: ${error.message}`,
            false,
            'The media processor is unavailable',
            { cause: error },
          ),
        ),
      );
    });
    child.once('close', (code) => {
      finish(() => {
        if (terminated === 'aborted') reject(signal?.reason);
        else if (terminated === 'timeout') reject(timeoutError(operation));
        else if (code !== 0)
          reject(
            new ProcessingError(
              `${operation} failed with exit code ${String(code)}: ${stderr}`,
              false,
              operation === 'ffprobe'
                ? 'The uploaded file is not a valid video'
                : 'The video could not be transcoded',
            ),
          );
        else resolve(stdout);
      });
    });
  });
}

function timeoutError(operation: string): ProcessingError {
  return new ProcessingError(
    `${operation} timed out`,
    true,
    'Video processing timed out',
  );
}

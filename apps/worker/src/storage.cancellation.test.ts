import { randomBytes } from 'node:crypto';
import type * as FsModule from 'node:fs';
import { createReadStream, existsSync, type ReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { S3Client } from '@aws-sdk/client-s3';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { AttemptDeadlineError } from './processing-error.js';
import { StorageService } from './storage.service.js';

// Spy on createReadStream so the test can inspect the real stream the upload
// opened. Reads are paced (50 ms per chunk) so the transfer is still in
// progress when the test cancels it, whatever the socket buffers hold.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return {
    ...actual,
    createReadStream: vi.fn(
      (...args: Parameters<typeof actual.createReadStream>) => {
        const stream = actual.createReadStream(...args);
        const read = stream._read.bind(stream);
        stream._read = (size: number) => {
          setTimeout(() => {
            if (!stream.destroyed) read(size);
          }, 50);
        };
        return stream;
      },
    ),
  };
});

/**
 * Real sockets, real streams, real AWS SDK client: the "storage" is a local
 * HTTP server that stalls on purpose, so these tests only pass when abort
 * actually tears the transfer down.
 */
interface StallingServer {
  endpoint: string;
  /** Resolves when the client dropped a connection. */
  disconnected: Promise<void>;
  close: () => Promise<void>;
}

const servers: StallingServer[] = [];
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'youtube-clone-cancel-'));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function startServer(
  onRequest: Parameters<typeof createServer>[1],
): Promise<StallingServer> {
  const sockets = new Set<Socket>();
  let markDisconnected!: () => void;
  const disconnected = new Promise<void>(
    (resolve) => (markDisconnected = resolve),
  );
  const server: Server = createServer(onRequest);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      markDisconnected();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const stalling: StallingServer = {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    disconnected,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(stalling);
  return stalling;
}

function storageAgainst(server: StallingServer): StorageService {
  const service = new StorageService();
  (service as unknown as { client: S3Client }).client = new S3Client({
    endpoint: server.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    maxAttempts: 1,
  });
  return service;
}

/** Aborts after `ms` and reports how long the operation took to give up. */
async function abortedAfter(
  ms: number,
  run: (signal: AbortSignal) => Promise<unknown>,
) {
  const controller = new AbortController();
  const reason = new AttemptDeadlineError();
  const startedAt = performance.now();
  setTimeout(() => controller.abort(reason), ms);
  const outcome = await run(controller.signal).then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );
  return { reason, ...outcome, elapsedMs: performance.now() - startedAt };
}

describe('StorageService cancellation', () => {
  it('abandons a download whose request never gets a response and drops the connection', async () => {
    const server = await startServer(() => undefined);
    const service = storageAgainst(server);

    const result = await abortedAfter(200, (signal) =>
      service.download(
        'originals',
        'a.mp4',
        join(directory, 'never-written'),
        null,
        signal,
      ),
    );

    expect(result.error).toBe(result.reason);
    expect(result.elapsedMs).toBeLessThan(3_000);
    await server.disconnected;
  });

  it('destroys the response stream and the destination file when a download stalls mid-body', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': 5_000_000 });
      response.write(randomBytes(4_096));
    });
    const service = storageAgainst(server);
    const destination = join(directory, 'partial.bin');

    const result = await abortedAfter(400, (signal) =>
      service.download('originals', 'a.mp4', destination, null, signal),
    );

    expect(result.error).toBe(result.reason);
    await server.disconnected;
    // A leaked write handle would make this fail on Windows (EBUSY/EPERM).
    await rm(destination, { force: true });
    expect(existsSync(destination)).toBe(false);
  });

  it('stops an in-flight upload and destroys the source file stream', async () => {
    const server = await startServer((request) => {
      request.pause();
    });
    const service = storageAgainst(server);
    const source = join(directory, 'large-thumbnail.jpg');
    await writeFile(source, randomBytes(8 * 1024 * 1024));

    const result = await abortedAfter(500, (signal) =>
      service.uploadThumbnail('video-id', 1, 'attempt-id', source, signal),
    );

    expect(result.error).toBe(result.reason);
    const stream = vi.mocked(createReadStream).mock.results[0]!
      .value as ReadStream;
    expect(stream.readableEnded).toBe(false); // it was cancelled mid-transfer
    expect(stream.destroyed).toBe(true);
    await rm(source); // fails on Windows if the read stream still holds the file
    expect(existsSync(source)).toBe(false);
  });

  it('bounds cleanup with its own signal instead of the cancelled attempt signal', async () => {
    const server = await startServer(() => undefined);
    const service = storageAgainst(server);

    const result = await abortedAfter(250, (cleanupSignal) =>
      service.removeAttempt('video-id', 1, 'attempt-id', cleanupSignal),
    );

    expect(result.error).toBe(result.reason);
    expect(result.elapsedMs).toBeLessThan(3_000);
  });
});

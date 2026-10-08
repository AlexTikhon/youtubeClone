import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from '@/shared/api/api-client';
import { ApiClientError } from '@/shared/api/api-error';
import { StorageUploadError, uploadFile } from '@/shared/upload/upload-file';
import type * as UploadFileNamespace from '@/shared/upload/upload-file';

import { VideoUploadForm } from './video-upload-form';

type UploadFileModule = typeof UploadFileNamespace;

vi.mock('@/shared/api/api-client', () => ({
  apiRequest: vi.fn(),
  resolveApiUrl: (value: string) => value,
}));
vi.mock('@/shared/upload/upload-file', async (importOriginal) => ({
  ...(await importOriginal<UploadFileModule>()),
  uploadFile: vi.fn(),
}));

const videoId = 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0';
const intent = {
  method: 'POST',
  uploadUrl: 'http://storage.test/video-originals',
  fields: { key: 'originals/v/f.mp4', 'Content-Type': 'video/mp4' },
  sizeBytes: 5,
  expiresInSeconds: 900,
};
const accepted = {
  videoId,
  status: 'UPLOADED',
  processingGeneration: 1,
  alreadyCompleted: false,
};
const owner = (status: string, extra: object = {}) => ({
  id: videoId,
  status,
  processingGeneration: 1,
  failureReason: null,
  ...extra,
});

type Handler = (path: string, options?: { method?: string }) => unknown;

function route(handlers: Record<string, Handler | unknown>) {
  vi.mocked(apiRequest).mockImplementation((path: string, options) => {
    const method = options?.method ?? 'GET';
    const key = `${method} ${path.replace(videoId, ':id')}`;
    const handler = handlers[key];
    if (handler === undefined)
      return Promise.reject(new Error(`Unexpected request ${key}`));
    const result =
      typeof handler === 'function'
        ? (handler as Handler)(path, options)
        : handler;
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
  });
}

const calls = (key: string) =>
  vi
    .mocked(apiRequest)
    .mock.calls.filter(
      ([path, options]) =>
        `${options?.method ?? 'GET'} ${(path as string).replace(videoId, ':id')}` ===
        key,
    );

function renderForm() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <VideoUploadForm />
    </QueryClientProvider>,
  );
}

function startUpload() {
  const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
  fireEvent.change(screen.getByLabelText('Video file'), {
    target: { files: [file] },
  });
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Recovery' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start upload' }));
}

const lostResponse = () => new ApiClientError('offline', 0, 'NETWORK_ERROR');

describe('VideoUploadForm recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uploadFile).mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it('keeps observing processing after a lost completion response, without uploading again', async () => {
    route({
      'POST /api/v1/videos': { id: videoId },
      'POST /api/v1/videos/:id/upload': intent,
      'POST /api/v1/videos/:id/upload/complete': lostResponse(),
      'GET /api/v1/videos/:id/owner': owner('PROCESSING'),
    });
    renderForm();

    startUpload();

    expect(
      await screen.findByText(/Your upload was received/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(calls('POST /api/v1/videos/:id/upload')).toHaveLength(1);
    expect(calls('POST /api/v1/videos/:id/upload/complete')).toHaveLength(1);
  });

  it('retries only finalization when completion is uncertain and the video still awaits it', async () => {
    let completions = 0;
    route({
      'POST /api/v1/videos': { id: videoId },
      'POST /api/v1/videos/:id/upload': intent,
      'POST /api/v1/videos/:id/upload/complete': () =>
        ++completions === 1
          ? new ApiClientError('unavailable', 503, 'STORAGE_UNAVAILABLE')
          : accepted,
      'GET /api/v1/videos/:id/owner': owner('UPLOADING', {
        processingGeneration: 0,
      }),
    });
    renderForm();

    startUpload();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not confirm');
    expect(alert).toHaveTextContent('stored');
    fireEvent.click(screen.getByRole('button', { name: 'Retry finalization' }));
    await waitFor(() => expect(completions).toBe(2));
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(calls('POST /api/v1/videos/:id/upload')).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
  });

  it('offers a fresh upload after a genuine storage failure', async () => {
    route({
      'POST /api/v1/videos': { id: videoId },
      'POST /api/v1/videos/:id/upload': intent,
      'POST /api/v1/videos/:id/upload/complete': accepted,
      'GET /api/v1/videos/:id/owner': owner('UPLOADED'),
    });
    vi.mocked(uploadFile).mockRejectedValueOnce(
      new StorageUploadError('Storage rejected the upload.', 'rejected', 400),
    );
    renderForm();

    startUpload();

    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed');
    expect(calls('POST /api/v1/videos/:id/upload/complete')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
    await waitFor(() =>
      expect(calls('POST /api/v1/videos/:id/upload/complete')).toHaveLength(1),
    );
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(calls('POST /api/v1/videos/:id/upload')).toHaveLength(2);
  });

  it('supports cancelling an in-flight upload and uploading again', async () => {
    route({
      'POST /api/v1/videos': { id: videoId },
      'POST /api/v1/videos/:id/upload': intent,
      'POST /api/v1/videos/:id/upload/complete': accepted,
      'GET /api/v1/videos/:id/owner': owner('UPLOADED'),
    });
    vi.mocked(uploadFile).mockImplementationOnce(
      ({ signal, onProgress }) =>
        new Promise<void>((_resolve, reject) => {
          onProgress?.(40);
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Upload cancelled', 'AbortError')),
          );
        }),
    );
    renderForm();

    startUpload();
    expect(await screen.findByText('40% uploaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Upload cancelled.')).toBeInTheDocument();
    expect(calls('POST /api/v1/videos/:id/upload/complete')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
    await waitFor(() =>
      expect(calls('POST /api/v1/videos/:id/upload/complete')).toHaveLength(1),
    );
  });

  it('shows a distinct processing failure with a retry-processing action', async () => {
    let processing = false;
    route({
      'POST /api/v1/videos': { id: videoId },
      'POST /api/v1/videos/:id/upload': intent,
      'POST /api/v1/videos/:id/upload/complete': accepted,
      'GET /api/v1/videos/:id/owner': () =>
        processing
          ? owner('PROCESSING', { processingGeneration: 2 })
          : owner('FAILED', {
              failureReason: 'The video could not be transcoded',
            }),
      'POST /api/v1/videos/:id/retry-processing': () => {
        processing = true;
        return { videoId, status: 'PROCESSING', processingGeneration: 2 };
      },
    });
    renderForm();

    startUpload();

    expect(await screen.findByText('Processing failed')).toBeInTheDocument();
    expect(
      screen.getByText('The video could not be transcoded'),
    ).toBeInTheDocument();
    // Upload failure and completion uncertainty are different recoveries.
    expect(
      screen.queryByRole('button', { name: 'Retry upload' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry finalization' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry processing' }));
    await waitFor(() =>
      expect(calls('POST /api/v1/videos/:id/retry-processing')).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.queryByText('Processing failed')).not.toBeInTheDocument(),
    );
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });
});

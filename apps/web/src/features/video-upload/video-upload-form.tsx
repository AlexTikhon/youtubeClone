'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';

import type {
  OwnerVideoDto,
  UploadCompletionResponse,
  UploadIntentResponse,
  VideoVisibility,
} from '@youtube-clone/types';

import { apiRequest } from '@/shared/api/api-client';
import { StorageUploadError, uploadFile } from '@/shared/upload/upload-file';
import { queryKeys } from '@/shared/query/query-keys';
import { getApiErrorPresentation } from '@/shared/api/api-error';

import {
  decideFromOwnerState,
  isUncertainApiFailure,
  recoveryForCompletionRejection,
  type RecoveryKind,
} from './upload-recovery';

export function validateVideoFile(file: File): string | null {
  if (file.size === 0) return 'Choose a non-empty video file.';
  if (file.type !== 'video/mp4') return 'Choose an MP4 video file.';
  return null;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function uploadErrorMessage(error: unknown, fallback: string) {
  if (isAbort(error)) return 'Upload cancelled.';
  if (error instanceof StorageUploadError) return error.message;
  return getApiErrorPresentation(error, fallback).message;
}

type UploadPhase =
  | 'idle'
  | 'creating'
  | 'uploading'
  | 'finalizing'
  | 'observing'
  | 'cancelled'
  | 'error';

interface UploadContext {
  videoId: string;
  file: File;
}

export function VideoUploadForm() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<VideoVisibility>('PUBLIC');
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryKind | null>(null);
  const [processingRetryError, setProcessingRetryError] = useState(false);
  const [retryingProcessing, setRetryingProcessing] = useState(false);
  const [context, setContext] = useState<UploadContext | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const video = useQuery({
    queryKey: queryKeys.ownerVideo(context?.videoId),
    queryFn: () =>
      apiRequest<OwnerVideoDto>(`/api/v1/videos/${context!.videoId}/owner`),
    enabled: Boolean(context?.videoId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'READY' || status === 'FAILED' ? false : 2_000;
    },
  });

  function fail(kind: RecoveryKind, message: string) {
    setPhase('error');
    setRecovery(kind);
    setError(message);
  }

  /** Sends the bytes to object storage under a fresh (or re-signed) intent. */
  async function uploadBytes(uploadContext: UploadContext): Promise<boolean> {
    const controller = new AbortController();
    abortController.current = controller;
    try {
      setError(null);
      setRecovery(null);
      setProgress(0);
      setPhase('uploading');
      const intent = await apiRequest<UploadIntentResponse>(
        `/api/v1/videos/${uploadContext.videoId}/upload`,
        {
          method: 'POST',
          body: {
            fileName: uploadContext.file.name,
            contentType: uploadContext.file.type,
            sizeBytes: uploadContext.file.size,
          },
        },
      );
      await uploadFile({
        url: intent.uploadUrl,
        fields: intent.fields,
        file: uploadContext.file,
        signal: controller.signal,
        onProgress: setProgress,
      });
      return true;
    } catch (uploadError) {
      if (isAbort(uploadError)) {
        setPhase('cancelled');
        setRecovery('upload-failed');
        setError(null);
      } else {
        fail(
          'upload-failed',
          uploadErrorMessage(uploadError, 'The upload could not be completed.'),
        );
      }
      return false;
    } finally {
      abortController.current = null;
    }
  }

  /**
   * Asks the server to accept the stored bytes. Completion is idempotent, so a
   * lost response is resolved by looking at what the owner can see before any
   * recovery is chosen — the bytes are never re-sent unless they are missing.
   */
  async function finalize(uploadContext: UploadContext) {
    setError(null);
    setRecovery(null);
    setPhase('finalizing');
    try {
      await apiRequest<UploadCompletionResponse>(
        `/api/v1/videos/${uploadContext.videoId}/upload/complete`,
        { method: 'POST' },
      );
      await accept();
    } catch (completionError) {
      if (!isUncertainApiFailure(completionError)) {
        const kind = recoveryForCompletionRejection(completionError);
        fail(
          kind,
          kind === 'upload-failed'
            ? `Upload failed: ${uploadErrorMessage(
                completionError,
                'The stored file could not be verified.',
              )}`
            : uploadErrorMessage(
                completionError,
                'The upload could not be finalized.',
              ),
        );
        return;
      }
      await resolveUncertainCompletion(uploadContext);
    }
  }

  async function accept() {
    setPhase('observing');
    await video.refetch();
  }

  async function resolveUncertainCompletion(uploadContext: UploadContext) {
    let owned: OwnerVideoDto;
    try {
      owned = await apiRequest<OwnerVideoDto>(
        `/api/v1/videos/${uploadContext.videoId}/owner`,
      );
    } catch {
      fail(
        'completion-uncertain',
        'We could not confirm that your upload was finalized, and could not check its status. Your file is stored; try finalizing again.',
      );
      return;
    }
    const decision = decideFromOwnerState(owned);
    if (decision === 'accepted') {
      await accept();
    } else if (decision === 'finalize') {
      fail(
        'completion-uncertain',
        'We could not confirm that your upload was finalized. Your file is stored, so there is no need to upload it again.',
      );
    } else {
      fail(
        'upload-failed',
        'Upload failed: the file was not received. Upload it again.',
      );
    }
  }

  async function uploadAndFinalize(uploadContext: UploadContext) {
    if (await uploadBytes(uploadContext)) await finalize(uploadContext);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return setError('Choose an MP4 file.');
    const validationError = validateVideoFile(file);
    if (validationError) return setError(validationError);
    if (!title.trim()) return setError('Enter a title.');
    try {
      setError(null);
      setProgress(0);
      setPhase('creating');
      const draft = await apiRequest<OwnerVideoDto>('/api/v1/videos', {
        method: 'POST',
        body: { title, description, visibility },
      });
      const nextContext = { videoId: draft.id, file };
      setContext(nextContext);
      await uploadAndFinalize(nextContext);
    } catch (createError) {
      setPhase('error');
      setError(
        uploadErrorMessage(
          createError,
          'The video draft could not be created.',
        ),
      );
    }
  }

  async function retryProcessing() {
    if (!context) return;
    setProcessingRetryError(false);
    setRetryingProcessing(true);
    try {
      await apiRequest(`/api/v1/videos/${context.videoId}/retry-processing`, {
        method: 'POST',
      });
      await video.refetch();
    } catch {
      setProcessingRetryError(true);
    } finally {
      setRetryingProcessing(false);
    }
  }

  const processingStatus = video.data?.status;
  const busy = ['creating', 'uploading', 'finalizing'].includes(phase);
  const accepted = phase === 'observing';
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
      <form
        className="space-y-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-7"
        onSubmit={submit}
      >
        <div>
          <h1 className="text-2xl font-bold">Upload a video</h1>
          <p className="mt-2 text-sm text-zinc-400" id="upload-help">
            MP4. Object storage itself rejects any file that does not match the
            size declared for this upload.
          </p>
        </div>
        <label className="block text-sm text-zinc-300">
          Video file
          <input
            accept="video/mp4,.mp4"
            aria-describedby="upload-help upload-error"
            aria-invalid={Boolean(error && !file)}
            className="field mt-2 file:mr-4 file:rounded-md file:border-0 file:bg-zinc-700 file:px-3 file:py-2 file:text-white"
            disabled={busy || Boolean(context)}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            type="file"
          />
        </label>
        <label className="block text-sm text-zinc-300">
          Title
          <input
            aria-describedby="upload-error"
            aria-invalid={Boolean(error && !title.trim())}
            className="field mt-2"
            disabled={busy || Boolean(context)}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            value={title}
          />
        </label>
        <label className="block text-sm text-zinc-300">
          Description
          <textarea
            className="field mt-2 min-h-28 resize-y"
            disabled={busy || Boolean(context)}
            maxLength={5000}
            onChange={(event) => setDescription(event.target.value)}
            value={description}
          />
        </label>
        <label className="block text-sm text-zinc-300">
          Visibility
          <select
            className="field mt-2"
            disabled={busy || Boolean(context)}
            onChange={(event) =>
              setVisibility(event.target.value as VideoVisibility)
            }
            value={visibility}
          >
            <option value="PUBLIC">Public</option>
            <option value="UNLISTED">Unlisted</option>
            <option value="PRIVATE">Private</option>
          </select>
        </label>
        {!context && (
          <button
            className="rounded-lg bg-red-600 px-5 py-3 font-semibold hover:bg-red-500 disabled:opacity-60"
            disabled={busy}
            type="submit"
          >
            {phase === 'creating' ? 'Creating…' : 'Start upload'}
          </button>
        )}
        {phase === 'uploading' && (
          <button
            className="ml-3 rounded-lg border border-zinc-700 px-5 py-3"
            onClick={() => abortController.current?.abort()}
            type="button"
          >
            Cancel
          </button>
        )}
        {context &&
          (phase === 'error' || phase === 'cancelled') &&
          recovery === 'upload-failed' && (
            <button
              className="rounded-lg bg-red-600 px-5 py-3 font-semibold"
              onClick={() => void uploadAndFinalize(context)}
              type="button"
            >
              Retry upload
            </button>
          )}
        {context &&
          phase === 'error' &&
          recovery === 'completion-uncertain' && (
            <button
              className="rounded-lg bg-red-600 px-5 py-3 font-semibold"
              onClick={() => void finalize(context)}
              type="button"
            >
              Retry finalization
            </button>
          )}
        {phase === 'cancelled' && (
          <p className="text-sm text-zinc-300">Upload cancelled.</p>
        )}
        {error && (
          <p className="text-sm text-red-400" id="upload-error" role="alert">
            {recovery === 'upload-failed' && !error.startsWith('Upload failed')
              ? `Upload failed: ${error}`
              : error}
          </p>
        )}
      </form>
      <aside className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <h2 className="font-semibold">Progress</h2>
        <div
          aria-label="Upload progress"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
          className="mt-6 h-2 overflow-hidden rounded bg-zinc-800"
          role="progressbar"
        >
          <div
            className="h-full bg-red-600 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p aria-live="polite" className="mt-3 text-sm text-zinc-400">
          {progress}% uploaded
        </p>
        <ol className="mt-6 space-y-3 text-sm text-zinc-400">
          <li className={context ? 'text-white' : ''}>1. Draft created</li>
          <li className={accepted || progress === 100 ? 'text-white' : ''}>
            2. Original uploaded
          </li>
          <li className={processingStatus === 'PROCESSING' ? 'text-white' : ''}>
            3. Processing
          </li>
          <li
            className={processingStatus === 'READY' ? 'text-emerald-400' : ''}
          >
            4. Ready
          </li>
        </ol>
        {accepted && !processingStatus && (
          <p className="mt-6 text-sm text-zinc-300">
            Your upload was received. Checking its status…
          </p>
        )}
        {accepted && processingStatus === 'UPLOADED' && (
          <p className="mt-6 text-sm text-zinc-300">
            Your upload was received and is waiting to be processed.
          </p>
        )}
        {accepted && processingStatus === 'PROCESSING' && (
          <p className="mt-6 text-sm text-amber-300">
            Your upload was received. FFmpeg is creating the thumbnail and
            adaptive HLS renditions…
          </p>
        )}
        {accepted && processingStatus === 'FAILED' && (
          <div className="mt-6 text-sm text-red-400">
            <p className="font-semibold">Processing failed</p>
            <p>{video.data?.failureReason ?? 'Processing failed.'}</p>
            {processingRetryError && (
              <p className="mt-2" role="alert">
                Processing could not be restarted. Please try again.
              </p>
            )}
            <button
              className="mt-3 rounded-lg bg-red-600 px-4 py-2 font-semibold text-white disabled:opacity-60"
              disabled={retryingProcessing}
              onClick={() => void retryProcessing()}
              type="button"
            >
              Retry processing
            </button>
          </div>
        )}
        {processingStatus === 'READY' && context && (
          <div className="mt-6 flex gap-3">
            <Link
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold"
              href={`/watch/${context.videoId}`}
            >
              Watch
            </Link>
            <Link
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm"
              href="/"
            >
              Home
            </Link>
          </div>
        )}
      </aside>
    </div>
  );
}

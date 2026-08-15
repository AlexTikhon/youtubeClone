'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';

import type {
  UploadIntentResponse,
  VideoSummary,
  VideoVisibility,
} from '@youtube-clone/types';

import { apiRequest } from '@/shared/api/api-client';
import { uploadFile } from '@/shared/upload/upload-file';

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

export function validateVideoFile(file: File): string | null {
  if (file.size === 0) return 'Choose a non-empty video file.';
  if (file.type !== 'video/mp4') return 'Phase 1 accepts MP4 video files.';
  if (file.size > MAX_FILE_SIZE) return 'The video exceeds the 2 GB limit.';
  return null;
}

type UploadPhase =
  'idle' | 'creating' | 'uploading' | 'finalizing' | 'cancelled' | 'error';

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
  const [context, setContext] = useState<UploadContext | null>(null);
  const abortController = useRef<AbortController | null>(null);

  const video = useQuery({
    queryKey: ['video', context?.videoId],
    queryFn: () =>
      apiRequest<VideoSummary>(`/api/v1/videos/${context!.videoId}`),
    enabled: Boolean(context?.videoId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'READY' || status === 'FAILED' ? false : 2_000;
    },
  });

  async function uploadAndFinalize(uploadContext: UploadContext) {
    const controller = new AbortController();
    abortController.current = controller;
    try {
      setError(null);
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
        file: uploadContext.file,
        headers: intent.requiredHeaders,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setPhase('finalizing');
      await apiRequest(
        `/api/v1/videos/${uploadContext.videoId}/upload/complete`,
        {
          method: 'POST',
        },
      );
      await video.refetch();
    } catch (uploadError) {
      if (
        uploadError instanceof DOMException &&
        uploadError.name === 'AbortError'
      ) {
        setPhase('cancelled');
      } else {
        setPhase('error');
        setError(
          uploadError instanceof Error
            ? uploadError.message
            : 'The upload could not be completed.',
        );
      }
    } finally {
      abortController.current = null;
    }
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
      const draft = await apiRequest<VideoSummary>('/api/v1/videos', {
        method: 'POST',
        body: { title, description, visibility },
      });
      const nextContext = { videoId: draft.id, file };
      setContext(nextContext);
      await uploadAndFinalize(nextContext);
    } catch (createError) {
      setPhase('error');
      setError(
        createError instanceof Error
          ? createError.message
          : 'The video draft could not be created.',
      );
    }
  }

  const processingStatus = video.data?.status;
  const busy = ['creating', 'uploading', 'finalizing'].includes(phase);
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
      <form
        className="space-y-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-7"
        onSubmit={submit}
      >
        <div>
          <h1 className="text-2xl font-bold">Upload a video</h1>
          <p className="mt-2 text-sm text-zinc-400">
            MP4, up to 2 GB. Uploads go directly to local object storage.
          </p>
        </div>
        <label className="block text-sm text-zinc-300">
          Video file
          <input
            accept="video/mp4,.mp4"
            className="field mt-2 file:mr-4 file:rounded-md file:border-0 file:bg-zinc-700 file:px-3 file:py-2 file:text-white"
            disabled={busy || Boolean(context)}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            type="file"
          />
        </label>
        <label className="block text-sm text-zinc-300">
          Title
          <input
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
        {(phase === 'uploading' || phase === 'finalizing') && (
          <button
            className="ml-3 rounded-lg border border-zinc-700 px-5 py-3"
            onClick={() => abortController.current?.abort()}
            type="button"
          >
            Cancel
          </button>
        )}
        {(phase === 'error' || phase === 'cancelled') && context && (
          <button
            className="rounded-lg bg-red-600 px-5 py-3 font-semibold"
            onClick={() => void uploadAndFinalize(context)}
            type="button"
          >
            Retry upload safely
          </button>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>
      <aside className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <h2 className="font-semibold">Progress</h2>
        <div className="mt-6 h-2 overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full bg-red-600 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="mt-3 text-sm text-zinc-400">{progress}% uploaded</p>
        <ol className="mt-6 space-y-3 text-sm text-zinc-400">
          <li className={context ? 'text-white' : ''}>1. Draft created</li>
          <li className={progress === 100 ? 'text-white' : ''}>
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
        {processingStatus === 'PROCESSING' && (
          <p className="mt-6 text-sm text-amber-300">
            FFmpeg is creating the thumbnail and HLS rendition…
          </p>
        )}
        {processingStatus === 'FAILED' && (
          <p className="mt-6 text-sm text-red-400">
            {video.data?.failureReason ?? 'Processing failed.'}
          </p>
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

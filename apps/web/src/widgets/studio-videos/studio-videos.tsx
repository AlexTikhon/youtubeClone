'use client';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type {
  CursorPage,
  OwnerVideoDto,
  VideoVisibility,
} from '@youtube-clone/types';
import { apiRequest, resolveApiUrl } from '@/shared/api/api-client';
import { formatCount, formatRelativeDate } from '@/shared/format/format';

export function StudioVideos() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<OwnerVideoDto | null>(null);
  const [deleting, setDeleting] = useState<OwnerVideoDto | null>(null);
  const videos = useInfiniteQuery({
    queryKey: ['studio', 'videos'],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiRequest<CursorPage<OwnerVideoDto>>(
        `/api/v1/studio/videos?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (page) => page.page.nextCursor ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.data.some((video) =>
          ['UPLOADED', 'PROCESSING'].includes(video.status),
        ),
      )
        ? 2_000
        : false,
    retry: false,
  });
  const retryProcessing = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/videos/${id}/retry-processing`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['studio', 'videos'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/videos/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setDeleting(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['studio', 'videos'] }),
        queryClient.invalidateQueries({ queryKey: ['feed'] }),
        queryClient.invalidateQueries({ queryKey: ['channel'] }),
      ]);
    },
  });
  const rows = videos.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <div>
      <div className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold">Studio</h1>
          <p className="mt-2 text-zinc-400">
            Manage uploads, visibility, and per-video engagement.
          </p>
        </div>
        <Link
          className="rounded-lg bg-red-600 px-4 py-2 font-semibold"
          href="/studio/upload"
        >
          Upload
        </Link>
      </div>
      {videos.isPending && (
        <p className="text-zinc-400">Loading your videos…</p>
      )}
      {videos.isError && <p className="text-red-400">Log in to open Studio.</p>}
      {!videos.isPending && !videos.isError && !rows.length && (
        <div className="rounded-2xl border border-dashed border-zinc-700 p-12 text-center text-zinc-400">
          No uploaded videos.
        </div>
      )}
      <div className="space-y-4">
        {rows.map((video) => (
          <article
            className="grid gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4 sm:grid-cols-[12rem_1fr_auto]"
            key={video.id}
          >
            <div className="aspect-video overflow-hidden rounded-lg bg-zinc-800">
              {video.thumbnailUrl && (
                <img
                  alt=""
                  className="h-full w-full object-cover"
                  src={resolveApiUrl(video.thumbnailUrl)}
                />
              )}
            </div>
            <div>
              <h2 className="font-semibold">{video.title}</h2>
              <p className="mt-2 text-sm text-zinc-400">
                {video.status} · {video.visibility} ·{' '}
                {formatRelativeDate(video.createdAt)}
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                Generation {video.processingGeneration} · updated{' '}
                {formatRelativeDate(video.updatedAt)}
              </p>
              <p className="mt-2 text-sm text-zinc-500">
                {formatCount(video.viewsCount)} views ·{' '}
                {formatCount(video.likesCount)} likes ·{' '}
                {formatCount(video.commentsCount)} comments
              </p>
              {video.status === 'FAILED' && (
                <div className="mt-3 text-sm text-red-400">
                  <p className="font-semibold">Processing failed</p>
                  <p>
                    {video.failureReason ?? 'The video could not be processed.'}
                  </p>
                  {retryProcessing.isError &&
                    retryProcessing.variables === video.id && (
                      <p className="mt-2">{retryProcessing.error.message}</p>
                    )}
                </div>
              )}
            </div>
            <div className="flex gap-3 sm:flex-col">
              {video.status === 'FAILED' && (
                <button
                  className="rounded bg-red-600 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
                  disabled={retryProcessing.isPending}
                  onClick={() => retryProcessing.mutate(video.id)}
                  type="button"
                >
                  {retryProcessing.isPending &&
                  retryProcessing.variables === video.id
                    ? 'Retrying…'
                    : 'Retry processing'}
                </button>
              )}
              <button
                className="rounded border border-zinc-700 px-3 py-1.5 text-sm"
                onClick={() => setEditing(video)}
                type="button"
              >
                Edit
              </button>
              <button
                className="rounded border border-red-900 px-3 py-1.5 text-sm text-red-400"
                onClick={() => setDeleting(video)}
                type="button"
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
      {videos.hasNextPage && (
        <button
          className="mt-6 rounded-lg border border-zinc-700 px-4 py-2"
          onClick={() => void videos.fetchNextPage()}
          type="button"
        >
          Load more
        </button>
      )}
      {editing && (
        <EditVideoDialog onClose={() => setEditing(null)} video={editing} />
      )}
      {deleting && (
        <div
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6"
          role="dialog"
        >
          <div className="max-w-md rounded-2xl bg-zinc-900 p-7">
            <h2 className="text-xl font-bold">
              Delete &quot;{deleting.title}&quot;?
            </h2>
            <p className="mt-3 text-zinc-400">
              This removes the video and its media assets.
            </p>
            {remove.isError && (
              <p className="mt-3 text-red-400">{remove.error.message}</p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button
                className="rounded border border-zinc-700 px-4 py-2"
                onClick={() => setDeleting(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="rounded bg-red-600 px-4 py-2 font-semibold"
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleting.id)}
                type="button"
              >
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EditVideoDialog({
  video,
  onClose,
}: {
  video: OwnerVideoDto;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(video.title);
  const [description, setDescription] = useState(video.description ?? '');
  const [visibility, setVisibility] = useState<VideoVisibility>(
    video.visibility,
  );
  const update = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/videos/${video.id}`, {
        method: 'PATCH',
        body: { title, description, visibility },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['studio', 'videos'] }),
        queryClient.invalidateQueries({ queryKey: ['feed'] }),
        queryClient.invalidateQueries({ queryKey: ['channel'] }),
        queryClient.invalidateQueries({ queryKey: ['video', video.id] }),
      ]);
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate();
  };
  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6"
      role="dialog"
    >
      <form
        className="w-full max-w-lg space-y-4 rounded-2xl bg-zinc-900 p-7"
        onSubmit={submit}
      >
        <h2 className="text-xl font-bold">Edit video</h2>
        <label className="block text-sm">
          Title
          <input
            className="field mt-2"
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            required
            value={title}
          />
        </label>
        <label className="block text-sm">
          Description
          <textarea
            className="field mt-2 min-h-28"
            maxLength={5000}
            onChange={(event) => setDescription(event.target.value)}
            value={description}
          />
        </label>
        <label className="block text-sm">
          Visibility
          <select
            className="field mt-2"
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
        {update.isError && (
          <p className="text-red-400">{update.error.message}</p>
        )}
        <div className="flex justify-end gap-3">
          <button
            className="rounded border border-zinc-700 px-4 py-2"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded bg-red-600 px-4 py-2 font-semibold"
            disabled={update.isPending}
            type="submit"
          >
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

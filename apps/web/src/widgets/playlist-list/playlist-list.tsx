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
  PlaylistSummaryDto,
  PlaylistVisibility,
} from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { queryKeys } from '@/shared/query/query-keys';
import { MediaThumbnail } from '@/shared/ui/media-thumbnail';
import { EmptyState, InlineError, PageSkeleton } from '@/shared/ui/async-state';

export function PlaylistList() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<PlaylistVisibility>('PRIVATE');
  const playlists = useInfiniteQuery({
    queryKey: queryKeys.playlist.mine(),
    initialPageParam: '',
    retry: false,
    queryFn: ({ pageParam }) =>
      apiRequest<CursorPage<PlaylistSummaryDto>>(
        `/api/v1/playlists/mine?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (page) => page.page.nextCursor ?? undefined,
  });
  const create = useMutation({
    mutationFn: () =>
      apiRequest<PlaylistSummaryDto>('/api/v1/playlists', {
        method: 'POST',
        body: { title, visibility },
      }),
    onSuccess: async () => {
      setTitle('');
      setCreating(false);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.playlist.lists,
      });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) create.mutate();
  };
  const rows = playlists.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <div>
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Playlists</h1>
          <p className="mt-2 text-zinc-400">
            Saved videos and curated collections.
          </p>
        </div>
        <button
          className="rounded-lg bg-red-600 px-4 py-2 font-semibold"
          onClick={() => setCreating((value) => !value)}
          type="button"
        >
          New playlist
        </button>
      </div>
      {creating && (
        <form
          className="mb-8 grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-5 sm:grid-cols-[1fr_auto_auto]"
          onSubmit={submit}
        >
          <input
            aria-label="Playlist title"
            className="field"
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Playlist title"
            value={title}
          />
          <select
            aria-label="Playlist visibility"
            className="field"
            onChange={(event) =>
              setVisibility(event.target.value as PlaylistVisibility)
            }
            value={visibility}
          >
            <option value="PRIVATE">Private</option>
            <option value="PUBLIC">Public</option>
          </select>
          <button
            className="rounded-lg bg-red-600 px-5 font-semibold"
            disabled={create.isPending}
            type="submit"
          >
            Create
          </button>
          {create.isError && (
            <p className="text-sm text-red-400 sm:col-span-3" role="alert">
              The playlist could not be created. Please try again.
            </p>
          )}
        </form>
      )}
      {playlists.isPending && <PageSkeleton variant="list" />}
      {playlists.isError && (
        <InlineError
          message="Playlists could not be loaded. Log in and try again."
          onRetry={() => void playlists.refetch()}
        />
      )}
      {!playlists.isPending && !playlists.isError && !rows.length && (
        <EmptyState title="No playlists yet." />
      )}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((playlist) => (
          <Link
            className="group"
            href={`/playlist/${playlist.id}`}
            key={playlist.id}
          >
            <div className="aspect-video overflow-hidden rounded-xl bg-zinc-800">
              <MediaThumbnail
                className="transition-transform group-hover:scale-[1.02] group-focus-visible:scale-[1.02]"
                src={playlist.coverThumbnailUrl}
              />
            </div>
            <h2 className="mt-3 font-semibold group-hover:text-red-300">
              {playlist.title}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              {playlist.videoCount} videos · {playlist.visibility}
            </p>
          </Link>
        ))}
      </div>
      {playlists.hasNextPage && (
        <button
          className="mt-8 rounded-lg border border-zinc-700 px-4 py-2"
          onClick={() => void playlists.fetchNextPage()}
          type="button"
        >
          Load more
        </button>
      )}
    </div>
  );
}

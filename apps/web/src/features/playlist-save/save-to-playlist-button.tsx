'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { CursorPage, PlaylistSummaryDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { ApiClientError } from '@/shared/api/api-error';
import { queryKeys } from '@/shared/query/query-keys';

export function SaveToPlaylistButton({ videoId }: { videoId: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const router = useRouter();
  const queryClient = useQueryClient();
  const playlists = useQuery({
    queryKey: queryKeys.playlistMine(videoId),
    enabled: open,
    retry: false,
    queryFn: () =>
      apiRequest<CursorPage<PlaylistSummaryDto>>(
        `/api/v1/playlists/mine?limit=50&videoId=${videoId}`,
      ),
  });
  const toggle = useMutation({
    mutationFn: (playlist: PlaylistSummaryDto) =>
      apiRequest(`/api/v1/playlists/${playlist.id}/videos/${videoId}`, {
        method: playlist.containsVideo ? 'DELETE' : 'PUT',
      }),
    onSuccess: async (_result, playlist) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.playlistMine(videoId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.playlist(playlist.id),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.playlists }),
      ]);
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const playlist = await apiRequest<PlaylistSummaryDto>(
        '/api/v1/playlists',
        {
          method: 'POST',
          body: { title, visibility: 'PRIVATE' },
        },
      );
      await apiRequest(`/api/v1/playlists/${playlist.id}/videos/${videoId}`, {
        method: 'PUT',
      });
      return playlist;
    },
    onSuccess: async () => {
      setTitle('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.playlists });
    },
  });
  const error = playlists.error ?? toggle.error ?? create.error;
  useEffect(() => {
    if (error instanceof ApiClientError && error.status === 401) {
      router.push(
        `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
      );
    }
  }, [error, router]);
  if (!open) {
    return (
      <button
        className="rounded-full bg-zinc-800 px-5 py-2 font-semibold"
        onClick={() => setOpen(true)}
        type="button"
      >
        Save
      </button>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) create.mutate();
  };
  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6"
      role="dialog"
    >
      <div className="w-full max-w-md rounded-2xl bg-zinc-900 p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">Save to...</h2>
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            type="button"
          >
            ✕
          </button>
        </div>
        {playlists.isPending && (
          <p className="mt-5 text-zinc-400">Loading playlists...</p>
        )}
        {playlists.isError &&
          playlists.error instanceof ApiClientError &&
          playlists.error.status !== 401 && (
            <p className="mt-5 text-red-400">Could not load playlists.</p>
          )}
        <div className="mt-5 max-h-64 space-y-2 overflow-auto">
          {playlists.data?.data.map((playlist) => (
            <label
              className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-zinc-800"
              key={playlist.id}
            >
              <input
                checked={playlist.containsVideo}
                disabled={toggle.isPending}
                onChange={() => toggle.mutate(playlist)}
                type="checkbox"
              />
              <span className="flex-1">{playlist.title}</span>
              <span className="text-xs text-zinc-500">
                {playlist.visibility}
              </span>
            </label>
          ))}
        </div>
        <form
          className="mt-5 flex gap-2 border-t border-zinc-800 pt-5"
          onSubmit={submit}
        >
          <input
            aria-label="New playlist title"
            className="field"
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="New playlist"
            value={title}
          />
          <button
            className="rounded-lg bg-red-600 px-4 font-semibold"
            disabled={create.isPending}
            type="submit"
          >
            Create
          </button>
        </form>
      </div>
    </div>
  );
}

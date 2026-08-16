'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type {
  PlaylistDetailDto,
  PlaylistVisibility,
} from '@youtube-clone/types';
import { VideoCard } from '@/entities/video/video-card';
import { apiRequest } from '@/shared/api/api-client';
import { queryKeys } from '@/shared/query/query-keys';

export function PlaylistDetail({ playlistId }: { playlistId: string }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const playlist = useQuery({
    queryKey: queryKeys.playlist(playlistId),
    queryFn: () =>
      apiRequest<PlaylistDetailDto>(`/api/v1/playlists/${playlistId}`),
    retry: false,
  });
  const removeVideo = useMutation({
    mutationFn: (videoId: string) =>
      apiRequest(`/api/v1/playlists/${playlistId}/videos/${videoId}`, {
        method: 'DELETE',
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.playlist(playlistId),
      }),
  });
  const removePlaylist = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/playlists/${playlistId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.playlists });
      router.push('/playlists');
    },
  });
  if (playlist.isPending)
    return <p className="text-zinc-400">Loading playlist...</p>;
  if (playlist.isError)
    return <p className="text-red-400">Playlist was not found.</p>;
  return (
    <div>
      <header className="mb-8 rounded-2xl bg-zinc-900 p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">{playlist.data.title}</h1>
            <p className="mt-2 text-zinc-400">
              by @{playlist.data.owner.username} · {playlist.data.videoCount}{' '}
              videos · {playlist.data.visibility}
            </p>
            {playlist.data.description && (
              <p className="mt-4 max-w-2xl text-zinc-300">
                {playlist.data.description}
              </p>
            )}
          </div>
          {playlist.data.ownedByCurrentUser &&
            playlist.data.type === 'STANDARD' && (
              <div className="flex gap-2">
                <button
                  className="rounded-lg border border-zinc-700 px-4 py-2"
                  onClick={() => setEditing(true)}
                  type="button"
                >
                  Edit
                </button>
                <button
                  className="rounded-lg border border-red-900 px-4 py-2 text-red-400"
                  disabled={removePlaylist.isPending}
                  onClick={() => removePlaylist.mutate()}
                  type="button"
                >
                  Delete
                </button>
              </div>
            )}
        </div>
      </header>
      {!playlist.data.videos.length && (
        <p className="rounded-2xl border border-dashed border-zinc-700 p-12 text-center text-zinc-400">
          This playlist has no playable videos.
        </p>
      )}
      <div className="space-y-6">
        {playlist.data.videos.map((item) => (
          <div
            className="grid gap-3 sm:grid-cols-[2rem_1fr_auto]"
            key={item.video.id}
          >
            <span className="pt-2 text-zinc-500">{item.position}</span>
            <VideoCard
              horizontal
              video={item.video}
              watchHref={`/watch/${item.video.id}?list=${playlistId}`}
            />
            {playlist.data.ownedByCurrentUser && (
              <button
                className="self-start text-sm text-zinc-400 hover:text-red-400"
                disabled={removeVideo.isPending}
                onClick={() => removeVideo.mutate(item.video.id)}
                type="button"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <EditPlaylist
          playlist={playlist.data}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function EditPlaylist({
  playlist,
  onClose,
}: {
  playlist: PlaylistDetailDto;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(playlist.title);
  const [description, setDescription] = useState(playlist.description ?? '');
  const [visibility, setVisibility] = useState<PlaylistVisibility>(
    playlist.visibility,
  );
  const update = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/playlists/${playlist.id}`, {
        method: 'PATCH',
        body: { title, description, visibility },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.playlist(playlist.id),
      });
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
        <h2 className="text-xl font-bold">Edit playlist</h2>
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
            className="field mt-2 min-h-24"
            maxLength={1000}
            onChange={(event) => setDescription(event.target.value)}
            value={description}
          />
        </label>
        <label className="block text-sm">
          Visibility
          <select
            className="field mt-2"
            onChange={(event) =>
              setVisibility(event.target.value as PlaylistVisibility)
            }
            value={visibility}
          >
            <option value="PRIVATE">Private</option>
            <option value="PUBLIC">Public</option>
          </select>
        </label>
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

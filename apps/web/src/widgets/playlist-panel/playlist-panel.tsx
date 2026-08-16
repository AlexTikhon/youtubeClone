'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { PlaylistDetailDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { queryKeys } from '@/shared/query/query-keys';

export function PlaylistPanel({
  playlistId,
  videoId,
  videoEnded,
}: {
  playlistId: string;
  videoId: string;
  videoEnded: boolean;
}) {
  const playlist = useQuery({
    queryKey: queryKeys.playlist(playlistId),
    queryFn: () =>
      apiRequest<PlaylistDetailDto>(`/api/v1/playlists/${playlistId}`),
    retry: false,
  });
  if (playlist.isPending)
    return <p className="text-zinc-400">Loading playlist...</p>;
  if (playlist.isError)
    return <p className="text-zinc-500">Playlist context is unavailable.</p>;
  const index = playlist.data.videos.findIndex(
    (item) => item.video.id === videoId,
  );
  const next = index >= 0 ? playlist.data.videos[index + 1] : undefined;
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="font-semibold">Playlist: {playlist.data.title}</h2>
      <p className="mt-1 text-xs text-zinc-500">
        {playlist.data.videoCount} videos
      </p>
      {videoEnded && next && (
        <Link
          className="mt-4 block rounded-lg bg-red-600 px-4 py-2 text-center font-semibold"
          href={`/watch/${next.video.id}?list=${playlistId}`}
        >
          Next video
        </Link>
      )}
      <ol className="mt-4 max-h-80 space-y-1 overflow-auto">
        {playlist.data.videos.map((item) => (
          <li key={item.video.id}>
            <Link
              aria-current={item.video.id === videoId ? 'true' : undefined}
              className={`grid grid-cols-[2rem_1fr] gap-2 rounded-lg p-2 text-sm hover:bg-zinc-800 ${item.video.id === videoId ? 'bg-zinc-800 text-red-300' : ''}`}
              href={`/watch/${item.video.id}?list=${playlistId}`}
            >
              <span>{item.position}</span>
              <span className="line-clamp-2">{item.video.title}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

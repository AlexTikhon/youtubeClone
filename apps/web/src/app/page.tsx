'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

import type { PublicVideoSummary } from '@youtube-clone/types';

import { apiRequest, resolveApiUrl } from '@/shared/api/api-client';

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

export default function HomePage() {
  const videos = useQuery({
    queryKey: ['videos', 'public'],
    queryFn: () => apiRequest<PublicVideoSummary[]>('/api/v1/videos'),
  });
  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold">Latest videos</h1>
          <p className="mt-2 text-zinc-400">
            Public videos that have finished processing.
          </p>
        </div>
        <Link
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold"
          href="/studio/upload"
        >
          Upload video
        </Link>
      </div>
      {videos.isPending && <p className="text-zinc-400">Loading videos…</p>}
      {videos.isError && <p className="text-red-400">Could not load videos.</p>}
      {videos.data?.length === 0 && (
        <div className="rounded-2xl border border-dashed border-zinc-700 p-12 text-center text-zinc-400">
          No public videos are ready yet. Upload the first one.
        </div>
      )}
      <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
        {videos.data?.map((video) => (
          <Link className="group" href={`/watch/${video.id}`} key={video.id}>
            <div className="relative aspect-video overflow-hidden rounded-xl bg-zinc-800">
              {/* The API media route enforces visibility and avoids exposing storage keys. */}
              <img
                alt=""
                className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                src={resolveApiUrl(video.thumbnailUrl)}
              />
              <span className="absolute bottom-2 right-2 rounded bg-black/85 px-1.5 py-0.5 text-xs">
                {formatDuration(video.durationSeconds)}
              </span>
            </div>
            <h2 className="mt-3 font-semibold leading-snug group-hover:text-red-300">
              {video.title}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">{video.channel.name}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}

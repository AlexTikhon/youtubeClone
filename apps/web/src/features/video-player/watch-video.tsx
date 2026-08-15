'use client';

import { useQuery } from '@tanstack/react-query';

import type { VideoSummary } from '@youtube-clone/types';

import { apiRequest } from '@/shared/api/api-client';
import { HlsVideoPlayer } from './hls-video-player';

export function WatchVideo({ videoId }: { videoId: string }) {
  const video = useQuery({
    queryKey: ['video', videoId],
    queryFn: () => apiRequest<VideoSummary>(`/api/v1/videos/${videoId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'READY' || status === 'FAILED' ? false : 2_000;
    },
    retry: false,
  });
  if (video.isPending) return <p className="text-zinc-400">Loading video…</p>;
  if (video.isError)
    return <p className="text-red-400">This video is unavailable.</p>;
  if (video.data.status === 'FAILED')
    return (
      <p className="text-red-400">
        {video.data.failureReason ?? 'Video processing failed.'}
      </p>
    );
  if (video.data.status !== 'READY' || !video.data.playbackUrl)
    return (
      <p className="text-amber-300">
        Video is {video.data.status.toLowerCase()}. This page updates
        automatically.
      </p>
    );
  return (
    <article>
      <div className="overflow-hidden rounded-xl border border-zinc-800">
        <HlsVideoPlayer playbackUrl={video.data.playbackUrl} />
      </div>
      <h1 className="mt-6 text-2xl font-bold">{video.data.title}</h1>
      <p className="mt-2 text-sm text-zinc-400">
        {video.data.channel.name} · {video.data.width}×{video.data.height} ·{' '}
        {video.data.durationSeconds}s
      </p>
      {video.data.description && (
        <p className="mt-6 whitespace-pre-wrap rounded-xl bg-zinc-900 p-5 text-zinc-300">
          {video.data.description}
        </p>
      )}
    </article>
  );
}

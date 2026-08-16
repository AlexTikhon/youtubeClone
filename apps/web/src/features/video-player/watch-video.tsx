'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { WatchVideoDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { formatCount, formatRelativeDate } from '@/shared/format/format';
import { useCurrentUser } from '@/shared/query/use-current-user';
import { LikeButton } from '@/features/video-like/like-button';
import { SubscribeButton } from '@/features/subscription/subscribe-button';
import { useWatchTracking } from '@/features/watch-history/use-watch-tracking';
import { CommentsSection } from '@/widgets/comments-section/comments-section';
import { RelatedVideos } from '@/widgets/related-videos/related-videos';
import { PlaylistPanel } from '@/widgets/playlist-panel/playlist-panel';
import { SaveToPlaylistButton } from '@/features/playlist-save/save-to-playlist-button';
import { queryKeys } from '@/shared/query/query-keys';
import { HlsVideoPlayer } from './hls-video-player';

export function WatchVideo({
  videoId,
  playlistId,
}: {
  videoId: string;
  playlistId?: string;
}) {
  const [videoEnded, setVideoEnded] = useState(false);
  useEffect(() => setVideoEnded(false), [videoId]);
  const user = useCurrentUser();
  const video = useQuery({
    queryKey: queryKeys.video(videoId),
    queryFn: () => apiRequest<WatchVideoDto>(`/api/v1/videos/${videoId}`),
    retry: false,
  });
  const tracking = useWatchTracking(
    videoId,
    video.data?.durationSeconds ?? 0,
    Boolean(user.data),
  );
  if (video.isPending) return <p className="text-zinc-400">Loading video…</p>;
  if (video.isError)
    return <p className="text-red-400">This video is unavailable.</p>;
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <article className="min-w-0">
        <div className="overflow-hidden rounded-xl border border-zinc-800">
          <HlsVideoPlayer
            initialPositionSeconds={video.data.resumePositionSeconds}
            onEnded={(progress) => {
              tracking.onEnded(progress);
              setVideoEnded(true);
            }}
            onPause={tracking.onPause}
            onProgress={tracking.onProgress}
            playbackUrl={video.data.playbackUrl}
          />
        </div>
        <h1 className="mt-6 text-2xl font-bold">{video.data.title}</h1>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <Link
            className="flex items-center gap-3"
            href={`/channel/${video.data.channel.handle}`}
          >
            <div className="grid size-11 place-items-center rounded-full bg-zinc-700">
              {video.data.channel.name.slice(0, 1).toUpperCase()}
            </div>
            <div>
              <p className="font-semibold">{video.data.channel.name}</p>
              <p className="text-xs text-zinc-400">
                {formatCount(video.data.channel.subscribersCount)} subscribers
              </p>
            </div>
          </Link>
          {user.data?.channel.id !== video.data.channel.id && (
            <SubscribeButton
              channel={video.data.channel}
              queryKey={['video', videoId]}
            />
          )}
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-zinc-400">
              {formatCount(video.data.viewsCount)} views
            </span>
            <LikeButton video={video.data} />
            {video.data.visibility === 'PUBLIC' && (
              <SaveToPlaylistButton videoId={videoId} />
            )}
          </div>
        </div>
        <div className="mt-6 rounded-xl bg-zinc-900 p-5">
          <p className="text-sm font-semibold">
            {formatCount(video.data.viewsCount)} views
            {video.data.publishedAt
              ? ` · ${formatRelativeDate(video.data.publishedAt)}`
              : ''}
          </p>
          {video.data.description ? (
            <p className="mt-3 whitespace-pre-wrap text-zinc-300">
              {video.data.description}
            </p>
          ) : (
            <p className="mt-3 text-zinc-500">No description.</p>
          )}
        </div>
        <CommentsSection
          commentsCount={video.data.commentsCount}
          videoId={videoId}
        />
      </article>
      <aside className="space-y-8">
        {playlistId && (
          <PlaylistPanel
            playlistId={playlistId}
            videoEnded={videoEnded}
            videoId={videoId}
          />
        )}
        <RelatedVideos videoId={videoId} />
      </aside>
    </div>
  );
}

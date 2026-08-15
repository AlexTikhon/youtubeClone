'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { ChannelDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { formatCount } from '@/shared/format/format';
import { SubscribeButton } from '@/features/subscription/subscribe-button';
import { VideoFeed } from '@/widgets/video-feed/video-feed';

export function ChannelView({ handle }: { handle: string }) {
  const channel = useQuery({
    queryKey: ['channel', handle],
    queryFn: () =>
      apiRequest<ChannelDto>(`/api/v1/channels/${encodeURIComponent(handle)}`),
    retry: false,
  });
  if (channel.isPending)
    return <p className="text-zinc-400">Loading channel…</p>;
  if (channel.isError)
    return <p className="text-red-400">Channel was not found.</p>;
  return (
    <div className="space-y-10">
      <section className="flex flex-wrap items-center gap-5 rounded-2xl bg-zinc-900 p-7">
        <div className="grid size-20 place-items-center rounded-full bg-zinc-700 text-2xl">
          {channel.data.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold">{channel.data.name}</h1>
          <p className="mt-1 text-zinc-400">
            @{channel.data.handle} ·{' '}
            {formatCount(channel.data.subscribersCount)} subscribers
          </p>
          {channel.data.description && (
            <p className="mt-3 max-w-2xl text-zinc-300">
              {channel.data.description}
            </p>
          )}
        </div>
        {channel.data.ownedByCurrentUser ? (
          <Link
            className="rounded-lg border border-zinc-700 px-4 py-2"
            href="/studio"
          >
            Open Studio
          </Link>
        ) : (
          <SubscribeButton
            channel={channel.data}
            queryKey={['channel', handle]}
          />
        )}
      </section>
      <section>
        <h2 className="mb-6 text-xl font-semibold">Videos</h2>
        <VideoFeed
          endpoint={`/api/v1/channels/${encodeURIComponent(handle)}/videos`}
          queryKey={['channel', handle, 'videos']}
          emptyMessage="No public videos."
        />
      </section>
    </div>
  );
}

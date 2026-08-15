'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { CursorPage, VideoCardDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { VideoGrid } from '@/widgets/video-grid/video-grid';

export function VideoFeed({
  endpoint,
  queryKey,
  emptyMessage,
}: {
  endpoint: string;
  queryKey: readonly string[];
  emptyMessage: string;
}) {
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiRequest<CursorPage<VideoCardDto>>(
        `${endpoint}?limit=18${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (page) => page.page.nextCursor ?? undefined,
  });
  const videos = query.data?.pages.flatMap((page) => page.data) ?? [];
  if (query.isPending) return <p className="text-zinc-400">Loading videos…</p>;
  if (query.isError)
    return <p className="text-red-400">Could not load videos.</p>;
  if (!videos.length)
    return (
      <div className="rounded-2xl border border-dashed border-zinc-700 p-12 text-center text-zinc-400">
        {emptyMessage}
      </div>
    );
  return (
    <div className="space-y-10">
      <VideoGrid videos={videos} />
      {query.hasNextPage && (
        <button
          className="rounded-lg border border-zinc-700 px-5 py-2 hover:border-zinc-500"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
          type="button"
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

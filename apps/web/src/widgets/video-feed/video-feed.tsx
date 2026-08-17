'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { CursorPage, VideoCardDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { VideoGrid } from '@/widgets/video-grid/video-grid';
import { getApiErrorPresentation } from '@/shared/api/api-error';
import {
  EmptyState,
  InlineError,
  VideoGridSkeleton,
} from '@/shared/ui/async-state';

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
    throwOnError: false,
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiRequest<CursorPage<VideoCardDto>>(
        `${endpoint}?limit=18${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (page) => page.page.nextCursor ?? undefined,
  });
  const videos = query.data?.pages.flatMap((page) => page.data) ?? [];
  if (query.isPending) return <VideoGridSkeleton />;
  if (query.isError)
    return (
      <InlineError
        message={
          getApiErrorPresentation(query.error, 'Could not load videos.').message
        }
        onRetry={() => void query.refetch()}
      />
    );
  if (!videos.length) return <EmptyState title={emptyMessage} />;
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

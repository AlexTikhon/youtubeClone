'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { CursorPage, VideoCardDto } from '@youtube-clone/types';
import { VideoCard } from '@/entities/video/video-card';
import { apiRequest } from '@/shared/api/api-client';
import { queryKeys } from '@/shared/query/query-keys';
import { EmptyState, InlineError, PageSkeleton } from '@/shared/ui/async-state';
import { getApiErrorPresentation } from '@/shared/api/api-error';

export function SearchResults({ query }: { query: string }) {
  const search = useInfiniteQuery({
    queryKey: queryKeys.search.results(query),
    initialPageParam: '',
    enabled: query.length > 0,
    queryFn: ({ pageParam }) =>
      apiRequest<CursorPage<VideoCardDto>>(
        `/api/v1/search?q=${encodeURIComponent(query)}&limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (page) => page.page.nextCursor ?? undefined,
    retry: false,
  });
  if (!query)
    return <EmptyState title="Enter a search term to find public videos." />;
  if (search.isPending) return <PageSkeleton variant="list" />;
  if (search.isError)
    return (
      <InlineError
        message={
          getApiErrorPresentation(search.error, 'Search is unavailable.')
            .message
        }
        onRetry={() => void search.refetch()}
      />
    );
  const results = search.data.pages.flatMap((page) => page.data);
  if (!results.length)
    return <EmptyState title="No videos matched this search." />;
  return (
    <div className="space-y-6">
      {results.map((video) => (
        <div className="max-w-4xl" key={video.id}>
          <VideoCard horizontal video={video} />
        </div>
      ))}
      {search.hasNextPage && (
        <button
          className="rounded-lg border border-zinc-700 px-5 py-2 hover:border-zinc-500"
          disabled={search.isFetchingNextPage}
          onClick={() => void search.fetchNextPage()}
          type="button"
        >
          {search.isFetchingNextPage ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}

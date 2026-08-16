'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { CursorPage, VideoCardDto } from '@youtube-clone/types';
import { VideoCard } from '@/entities/video/video-card';
import { apiRequest } from '@/shared/api/api-client';
import { queryKeys } from '@/shared/query/query-keys';

export function SearchResults({ query }: { query: string }) {
  const search = useInfiniteQuery({
    queryKey: queryKeys.search(query),
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
    return (
      <EmptyMessage>Enter a search term to find public videos.</EmptyMessage>
    );
  if (search.isPending)
    return <p className="text-zinc-400">Searching videos...</p>;
  if (search.isError)
    return (
      <p className="text-red-400">Search is unavailable. Please try again.</p>
    );
  const results = search.data.pages.flatMap((page) => page.data);
  if (!results.length)
    return <EmptyMessage>No videos matched this search.</EmptyMessage>;
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

function EmptyMessage({ children }: { children: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-700 p-12 text-center text-zinc-400">
      {children}
    </div>
  );
}

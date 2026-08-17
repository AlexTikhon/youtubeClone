'use client';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import Link from 'next/link';
import type { CursorPage, HistoryItemDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { formatDuration, formatRelativeDate } from '@/shared/format/format';
import { queryKeys } from '@/shared/query/query-keys';
import { MediaThumbnail } from '@/shared/ui/media-thumbnail';
import { EmptyState, InlineError, PageSkeleton } from '@/shared/ui/async-state';

export function HistoryList() {
  const queryClient = useQueryClient();
  const history = useInfiniteQuery({
    queryKey: queryKeys.history.all,
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiRequest<CursorPage<HistoryItemDto>>(
        `/api/v1/history?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (page) => page.page.nextCursor ?? undefined,
    retry: false,
  });
  const remove = useMutation({
    mutationFn: (videoId: string) =>
      apiRequest(`/api/v1/history/${videoId}`, { method: 'DELETE' }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.history.all }),
  });
  const items = history.data?.pages.flatMap((page) => page.data) ?? [];
  if (history.isPending) return <PageSkeleton variant="list" />;
  if (history.isError)
    return (
      <InlineError
        message="Log in to view your watch history."
        onRetry={() => void history.refetch()}
      />
    );
  if (!items.length)
    return <EmptyState title="You haven't watched anything yet." />;
  return (
    <div className="space-y-6">
      {remove.isError && (
        <InlineError message="The history item could not be removed." />
      )}
      {items.map((item) => (
        <article
          className="grid gap-4 sm:grid-cols-[18rem_1fr_auto]"
          key={item.video.id}
        >
          <Link
            className="relative aspect-video overflow-hidden rounded-xl bg-zinc-800"
            href={`/watch/${item.video.id}`}
          >
            <MediaThumbnail src={item.video.thumbnailUrl} />
            <div className="absolute inset-x-0 bottom-0 h-1 bg-zinc-700">
              <div
                className="h-full bg-red-600"
                style={{
                  width: `${Math.min(100, (item.lastPositionSeconds / item.video.durationSeconds) * 100)}%`,
                }}
              />
            </div>
          </Link>
          <div>
            <Link
              className="text-lg font-semibold hover:text-red-300"
              href={`/watch/${item.video.id}`}
            >
              {item.video.title}
            </Link>
            <p className="mt-2 text-sm text-zinc-400">
              {item.video.channel.name}
            </p>
            <p className="mt-2 text-sm text-zinc-500">
              Watched {formatRelativeDate(item.lastWatchedAt)} ·{' '}
              {formatDuration(item.lastPositionSeconds)} of{' '}
              {formatDuration(item.video.durationSeconds)}
            </p>
          </div>
          <button
            className="self-start text-sm text-zinc-400 hover:text-red-400"
            disabled={remove.isPending}
            onClick={() => remove.mutate(item.video.id)}
            type="button"
          >
            Remove
          </button>
        </article>
      ))}
      {history.hasNextPage && (
        <button
          className="rounded-lg border border-zinc-700 px-4 py-2"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
          type="button"
        >
          {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

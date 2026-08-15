'use client';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import Link from 'next/link';
import type { CursorPage, HistoryItemDto } from '@youtube-clone/types';
import { apiRequest, resolveApiUrl } from '@/shared/api/api-client';
import { formatDuration, formatRelativeDate } from '@/shared/format/format';

export function HistoryList() {
  const queryClient = useQueryClient();
  const history = useInfiniteQuery({
    queryKey: ['history'],
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['history'] }),
  });
  const items = history.data?.pages.flatMap((page) => page.data) ?? [];
  if (history.isPending)
    return <p className="text-zinc-400">Loading history…</p>;
  if (history.isError)
    return <p className="text-red-400">Log in to view your watch history.</p>;
  if (!items.length)
    return (
      <div className="rounded-2xl border border-dashed border-zinc-700 p-12 text-center text-zinc-400">
        You haven&apos;t watched anything yet.
      </div>
    );
  return (
    <div className="space-y-6">
      {items.map((item) => (
        <article
          className="grid gap-4 sm:grid-cols-[18rem_1fr_auto]"
          key={item.video.id}
        >
          <Link
            className="relative aspect-video overflow-hidden rounded-xl bg-zinc-800"
            href={`/watch/${item.video.id}`}
          >
            {item.video.thumbnailUrl && (
              <img
                alt={`Thumbnail for ${item.video.title}`}
                className="h-full w-full object-cover"
                src={resolveApiUrl(item.video.thumbnailUrl)}
              />
            )}
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
          onClick={() => void history.fetchNextPage()}
          type="button"
        >
          Load more
        </button>
      )}
    </div>
  );
}

'use client';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { CommentDto, CursorPage } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { ApiClientError } from '@/shared/api/api-error';
import { formatRelativeDate } from '@/shared/format/format';

export function CommentsSection({
  videoId,
  commentsCount,
}: {
  videoId: string;
  commentsCount: number;
}) {
  const key = ['comments', videoId] as const;
  const queryClient = useQueryClient();
  const router = useRouter();
  const [content, setContent] = useState('');
  const comments = useInfiniteQuery({
    queryKey: key,
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiRequest<CursorPage<CommentDto>>(
        `/api/v1/videos/${videoId}/comments?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (page) => page.page.nextCursor ?? undefined,
  });
  const create = useMutation({
    mutationFn: () =>
      apiRequest<CommentDto>(`/api/v1/videos/${videoId}/comments`, {
        method: 'POST',
        body: { content },
      }),
    onSuccess: async () => {
      setContent('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: ['video', videoId] }),
      ]);
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.status === 401)
        router.push(`/login?next=${encodeURIComponent(location.pathname)}`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/comments/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: ['video', videoId] }),
      ]),
  });
  const data = comments.data?.pages.flatMap((page) => page.data) ?? [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (content.trim()) create.mutate();
  };
  return (
    <section className="mt-10 border-t border-zinc-800 pt-8">
      <h2 className="text-xl font-semibold">Comments {commentsCount}</h2>
      <form className="mt-5 flex gap-3" onSubmit={submit}>
        <label className="sr-only" htmlFor="new-comment">
          Add comment
        </label>
        <textarea
          id="new-comment"
          className="field min-h-20 flex-1 resize-y"
          maxLength={2000}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Add a comment…"
          value={content}
        />
        <button
          className="self-end rounded-lg bg-red-600 px-4 py-2 font-semibold disabled:opacity-50"
          disabled={create.isPending || !content.trim()}
          type="submit"
        >
          Comment
        </button>
      </form>
      {create.isError &&
        !(
          create.error instanceof ApiClientError && create.error.status === 401
        ) && (
          <p className="mt-2 text-sm text-red-400">{create.error.message}</p>
        )}
      {comments.isPending && (
        <p className="mt-6 text-zinc-400">Loading comments…</p>
      )}
      {comments.isError && (
        <p className="mt-6 text-red-400">Could not load comments.</p>
      )}
      {!comments.isPending && !data.length && (
        <p className="mt-6 text-zinc-400">No comments yet.</p>
      )}
      <div className="mt-7 space-y-6">
        {data.map((comment) => (
          <article className="flex gap-3" key={comment.id}>
            <div className="grid size-9 shrink-0 place-items-center rounded-full bg-zinc-700">
              {comment.author.username.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                @{comment.author.username}{' '}
                <span className="font-normal text-zinc-500">
                  {formatRelativeDate(comment.createdAt)}
                </span>
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-zinc-200">
                {comment.content}
              </p>
              {comment.canDelete && (
                <button
                  className="mt-2 text-xs text-zinc-500 hover:text-red-400"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(comment.id)}
                  type="button"
                >
                  Delete
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {comments.hasNextPage && (
        <button
          className="mt-7 rounded-lg border border-zinc-700 px-4 py-2"
          onClick={() => void comments.fetchNextPage()}
          type="button"
        >
          Load more comments
        </button>
      )}
    </section>
  );
}

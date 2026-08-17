'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { LikeStateDto, WatchVideoDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { ApiClientError } from '@/shared/api/api-error';
import { formatCount } from '@/shared/format/format';
import { queryKeys } from '@/shared/query/query-keys';

export function optimisticLikeState(video: WatchVideoDto): WatchVideoDto {
  return {
    ...video,
    likedByCurrentUser: !video.likedByCurrentUser,
    likesCount: Math.max(
      0,
      video.likesCount + (video.likedByCurrentUser ? -1 : 1),
    ),
  };
}

export function LikeButton({ video }: { video: WatchVideoDto }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const key = queryKeys.video.detail(video.id);
  const mutation = useMutation({
    mutationFn: (liked: boolean) =>
      apiRequest<LikeStateDto>(`/api/v1/videos/${video.id}/like`, {
        method: liked ? 'DELETE' : 'PUT',
      }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<WatchVideoDto>(key);
      if (previous)
        queryClient.setQueryData<WatchVideoDto>(
          key,
          optimisticLikeState(previous),
        );
      return previous;
    },
    onError: (error, _liked, previous) => {
      if (previous) queryClient.setQueryData(key, previous);
      if (error instanceof ApiClientError && error.status === 401)
        router.push(`/login?next=${encodeURIComponent(location.pathname)}`);
    },
    onSuccess: (state) =>
      queryClient.setQueryData<WatchVideoDto>(key, (current) =>
        current
          ? {
              ...current,
              likedByCurrentUser: state.liked,
              likesCount: state.likesCount,
            }
          : current,
      ),
  });
  return (
    <>
      <button
        aria-pressed={video.likedByCurrentUser}
        className={
          video.likedByCurrentUser
            ? 'rounded-full bg-red-600 px-5 py-2 font-semibold'
            : 'rounded-full bg-zinc-800 px-5 py-2 font-semibold'
        }
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(video.likedByCurrentUser)}
        type="button"
      >
        Like {formatCount(video.likesCount)}
      </button>
      {mutation.isError &&
        !(
          mutation.error instanceof ApiClientError &&
          mutation.error.status === 401
        ) && (
          <span className="text-xs text-red-400" role="alert">
            Like failed. Your previous choice was restored.
          </span>
        )}
    </>
  );
}

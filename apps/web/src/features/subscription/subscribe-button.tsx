'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ChannelDto, SubscriptionStateDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { ApiClientError } from '@/shared/api/api-error';
import { queryKeys } from '@/shared/query/query-keys';

export function SubscribeButton({
  channel,
  queryKey,
}: {
  channel: Pick<
    ChannelDto,
    'id' | 'subscribedByCurrentUser' | 'subscribersCount'
  >;
  queryKey: readonly unknown[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [state, setState] = useState({
    subscribed: channel.subscribedByCurrentUser,
    count: channel.subscribersCount,
  });
  useEffect(
    () =>
      setState({
        subscribed: channel.subscribedByCurrentUser,
        count: channel.subscribersCount,
      }),
    [channel.subscribedByCurrentUser, channel.subscribersCount],
  );
  const mutation = useMutation({
    mutationFn: (subscribed: boolean) =>
      apiRequest<SubscriptionStateDto>(
        `/api/v1/channels/${channel.id}/subscription`,
        { method: subscribed ? 'DELETE' : 'PUT' },
      ),
    onMutate: (subscribed) => {
      const previous = state;
      setState({
        subscribed: !subscribed,
        count: Math.max(0, previous.count + (subscribed ? -1 : 1)),
      });
      return previous;
    },
    onError: (error, _value, previous) => {
      if (previous) setState(previous);
      if (error instanceof ApiClientError && error.status === 401)
        router.push(`/login?next=${encodeURIComponent(location.pathname)}`);
    },
    onSuccess: (result) =>
      setState({
        subscribed: result.subscribed,
        count: result.subscriberCount,
      }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.feed.subscriptions,
      });
    },
  });
  return (
    <>
      <button
        aria-pressed={state.subscribed}
        className={
          state.subscribed
            ? 'rounded-full bg-zinc-700 px-5 py-2 font-semibold'
            : 'rounded-full bg-white px-5 py-2 font-semibold text-black'
        }
        disabled={mutation.isPending}
        onClick={() => mutation.mutate(state.subscribed)}
        type="button"
      >
        {state.subscribed ? 'Subscribed' : 'Subscribe'}
      </button>
      {mutation.isError &&
        !(
          mutation.error instanceof ApiClientError &&
          mutation.error.status === 401
        ) && (
          <span className="text-xs text-red-400" role="alert">
            Subscription change failed. Your previous setting was restored.
          </span>
        )}
    </>
  );
}

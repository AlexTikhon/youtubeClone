'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { ChannelDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { getApiErrorPresentation } from '@/shared/api/api-error';
import { queryKeys } from '@/shared/query/query-keys';
import { InlineError, PageSkeleton } from '@/shared/ui/async-state';

export function ChannelSettingsForm() {
  const queryClient = useQueryClient();
  const channel = useQuery({
    queryKey: queryKeys.channel.mine,
    queryFn: () => apiRequest<ChannelDto>('/api/v1/channels/mine/settings'),
    retry: false,
  });
  if (channel.isPending) return <PageSkeleton variant="list" />;
  if (channel.isError)
    return (
      <InlineError
        message={
          getApiErrorPresentation(
            channel.error,
            'Could not load channel settings.',
          ).message
        }
        onRetry={() => void channel.refetch()}
      />
    );
  return (
    <LoadedChannelSettings channel={channel.data} queryClient={queryClient} />
  );
}

function LoadedChannelSettings({
  channel,
  queryClient,
}: {
  channel: ChannelDto;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description ?? '');
  const update = useMutation({
    mutationFn: () =>
      apiRequest<ChannelDto>('/api/v1/channels/mine/settings', {
        method: 'PATCH',
        body: { name, description },
      }),
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKeys.channel.mine, result);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.channel.detail(channel.handle),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.feed.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.search.all }),
      ]);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate();
  };
  return (
    <form
      className="max-w-2xl space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-7"
      onSubmit={submit}
    >
      <label className="block text-sm">
        Channel name
        <input
          className="field mt-2"
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          required
          value={name}
        />
      </label>
      <label className="block text-sm">
        Description
        <textarea
          className="field mt-2 min-h-32"
          maxLength={1000}
          onChange={(event) => setDescription(event.target.value)}
          value={description}
        />
      </label>
      <p className="text-sm text-zinc-500">Handle: @{channel.handle} (fixed)</p>
      {update.isError && (
        <p className="text-red-400" role="alert">
          {
            getApiErrorPresentation(
              update.error,
              'Could not update the channel.',
            ).message
          }
        </p>
      )}
      {update.isSuccess && (
        <p aria-live="polite" className="text-green-400">
          Channel updated.
        </p>
      )}
      <button
        className="rounded-lg bg-red-600 px-5 py-2 font-semibold disabled:opacity-60"
        disabled={update.isPending}
        type="submit"
      >
        {update.isPending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

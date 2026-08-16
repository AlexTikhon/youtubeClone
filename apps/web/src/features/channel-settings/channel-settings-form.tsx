'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { ChannelDto } from '@youtube-clone/types';
import { apiRequest } from '@/shared/api/api-client';
import { queryKeys } from '@/shared/query/query-keys';

export function ChannelSettingsForm() {
  const queryClient = useQueryClient();
  const channel = useQuery({
    queryKey: queryKeys.channelMine,
    queryFn: () => apiRequest<ChannelDto>('/api/v1/channels/mine/settings'),
    retry: false,
  });
  if (channel.isPending)
    return <p className="text-zinc-400">Loading channel settings...</p>;
  if (channel.isError)
    return <p className="text-red-400">Log in to edit your channel.</p>;
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
      queryClient.setQueryData(queryKeys.channelMine, result);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.channel(channel.handle),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.feeds }),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
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
        <p className="text-red-400">Could not update the channel.</p>
      )}
      {update.isSuccess && <p className="text-green-400">Channel updated.</p>}
      <button
        className="rounded-lg bg-red-600 px-5 py-2 font-semibold"
        disabled={update.isPending}
        type="submit"
      >
        Save changes
      </button>
    </form>
  );
}

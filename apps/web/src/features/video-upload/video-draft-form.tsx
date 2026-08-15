'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';

import type { VideoSummary } from '@youtube-clone/types';
import {
  createVideoSchema,
  type CreateVideoInput,
} from '@youtube-clone/validation';

import { apiRequest } from '@/shared/api/api-client';
import { ApiClientError } from '@/shared/api/api-error';

const fieldClassName =
  'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-500/20';

type VideoDraftFormInput = z.input<typeof createVideoSchema>;

export function VideoDraftForm() {
  const form = useForm<VideoDraftFormInput, unknown, CreateVideoInput>({
    resolver: zodResolver(createVideoSchema),
    defaultValues: {
      channelId: '',
      title: '',
      description: '',
      visibility: 'PRIVATE',
    },
  });
  const mutation = useMutation({
    mutationFn: (input: CreateVideoInput) =>
      apiRequest<VideoSummary>('/api/v1/videos', {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => form.reset(),
  });

  return (
    <aside className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl shadow-black/20">
      <h2 className="text-lg font-semibold">Create a video draft</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-400">
        Uses the authenticated API boundary. Seed a local session before trying
        this form.
      </p>
      <form
        className="mt-6 space-y-4"
        onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
      >
        <label className="block text-sm text-zinc-300">
          Channel ID
          <input
            className={`${fieldClassName} mt-1.5`}
            {...form.register('channelId')}
          />
          {form.formState.errors.channelId && (
            <span className="mt-1 block text-xs text-red-400">
              Enter a valid channel UUID.
            </span>
          )}
        </label>
        <label className="block text-sm text-zinc-300">
          Title
          <input
            className={`${fieldClassName} mt-1.5`}
            {...form.register('title')}
          />
          {form.formState.errors.title && (
            <span className="mt-1 block text-xs text-red-400">
              A title is required.
            </span>
          )}
        </label>
        <label className="block text-sm text-zinc-300">
          Description
          <textarea
            className={`${fieldClassName} mt-1.5 min-h-24 resize-y`}
            {...form.register('description')}
          />
        </label>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {mutation.isPending ? 'Creating…' : 'Create draft'}
        </button>
        {mutation.isSuccess && (
          <p className="text-sm text-emerald-400">Draft created.</p>
        )}
        {mutation.isError && (
          <p className="text-sm text-red-400">
            {mutation.error instanceof ApiClientError
              ? `${mutation.error.message} (${mutation.error.code})`
              : 'Could not create the draft.'}
          </p>
        )}
      </form>
    </aside>
  );
}

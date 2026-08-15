'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import type { AuthenticatedUserResponse } from '@youtube-clone/types';

import { apiRequest } from '@/shared/api/api-client';

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('developer@example.test');
  const [password, setPassword] = useState('youtube-clone-dev');
  const login = useMutation({
    mutationFn: () =>
      apiRequest<AuthenticatedUserResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: { email, password },
      }),
    onSuccess: (user) => {
      queryClient.clear();
      queryClient.setQueryData(['auth', 'me'], user);
      router.push(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate();
  };
  return (
    <form
      className="space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-7"
      onSubmit={submit}
    >
      <div>
        <h1 className="text-2xl font-bold">Log in</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Use the seeded local development account.
        </p>
      </div>
      <label className="block text-sm text-zinc-300">
        Email
        <input
          className="field mt-2"
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
      </label>
      <label className="block text-sm text-zinc-300">
        Password
        <input
          className="field mt-2"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
      </label>
      <button
        className="w-full rounded-lg bg-red-600 px-4 py-3 font-semibold hover:bg-red-500 disabled:opacity-60"
        disabled={login.isPending}
        type="submit"
      >
        {login.isPending ? 'Logging in…' : 'Log in'}
      </button>
      {login.isError && (
        <p className="text-sm text-red-400">{login.error.message}</p>
      )}
    </form>
  );
}

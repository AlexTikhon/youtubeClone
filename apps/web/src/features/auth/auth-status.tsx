'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

import type { AuthenticatedUserResponse } from '@youtube-clone/types';

import { apiRequest } from '@/shared/api/api-client';

export function AuthStatus() {
  const queryClient = useQueryClient();
  const user = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => apiRequest<AuthenticatedUserResponse>('/api/v1/auth/me'),
    retry: false,
  });
  const logout = useMutation({
    mutationFn: () =>
      apiRequest<{ success: true }>('/api/v1/auth/logout', { method: 'POST' }),
    onSettled: async () => {
      queryClient.setQueryData(['auth', 'me'], null);
      await queryClient.invalidateQueries({ queryKey: ['auth'] });
    },
  });
  if (!user.data)
    return (
      <Link
        className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold"
        href="/login"
      >
        Log in
      </Link>
    );
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="hidden text-zinc-400 sm:inline">
        @{user.data.channel.handle}
      </span>
      <button
        className="rounded-lg border border-zinc-700 px-3 py-2 hover:border-zinc-500"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
        type="button"
      >
        Log out
      </button>
    </div>
  );
}

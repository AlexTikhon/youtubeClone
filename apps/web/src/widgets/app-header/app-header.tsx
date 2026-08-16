import Link from 'next/link';
import { Suspense } from 'react';

import { AuthStatus } from '@/features/auth/auth-status';
import { SearchForm } from '@/features/search/search-form';

export function AppHeader() {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/90">
      <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center gap-4 px-4 py-3 lg:px-8">
        <div className="flex items-center gap-6">
          <Link className="flex items-center gap-3 font-semibold" href="/">
            <span className="grid size-9 place-items-center rounded-xl bg-red-600">
              ▶
            </span>
            <span className="hidden sm:inline">YouTubeClone</span>
          </Link>
          <nav className="hidden gap-4 text-sm text-zinc-400 lg:flex">
            <Link className="hover:text-white" href="/">
              Home
            </Link>
            <Link className="hover:text-white" href="/subscriptions">
              Subscriptions
            </Link>
            <Link className="hover:text-white" href="/history">
              History
            </Link>
            <Link className="hover:text-white" href="/playlists">
              Playlists
            </Link>
            <Link className="hover:text-white" href="/studio">
              Studio
            </Link>
            <Link className="hover:text-white" href="/studio/upload">
              Upload
            </Link>
          </nav>
        </div>
        <div className="order-3 flex w-full min-w-0 flex-1 md:order-none md:mx-auto md:max-w-xl">
          <Suspense
            fallback={<div className="h-10 w-full rounded-full bg-zinc-900" />}
          >
            <SearchForm />
          </Suspense>
        </div>
        <div className="ml-auto">
          <AuthStatus />
        </div>
      </div>
    </header>
  );
}

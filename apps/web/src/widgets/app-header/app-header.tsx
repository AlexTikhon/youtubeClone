import Link from 'next/link';
import { Suspense } from 'react';

import { AuthStatus } from '@/features/auth/auth-status';
import { SearchForm } from '@/features/search/search-form';

const navigation = [
  ['Home', '/'],
  ['Subscriptions', '/subscriptions'],
  ['History', '/history'],
  ['Playlists', '/playlists'],
  ['Studio', '/studio'],
  ['Upload', '/studio/upload'],
] as const;

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
          <nav
            aria-label="Primary"
            className="hidden gap-4 text-sm text-zinc-400 lg:flex"
          >
            {navigation.map(([label, href]) => (
              <Link className="hover:text-white" href={href} key={href}>
                {label}
              </Link>
            ))}
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
        <nav
          aria-label="Primary"
          className="order-4 flex w-full gap-5 overflow-x-auto pb-1 text-sm text-zinc-400 lg:hidden"
        >
          {navigation.map(([label, href]) => (
            <Link className="shrink-0 hover:text-white" href={href} key={href}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}

import Link from 'next/link';

import { AuthStatus } from '@/features/auth/auth-status';

export function AppHeader() {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/90">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6 lg:px-10">
        <div className="flex items-center gap-8">
          <Link className="flex items-center gap-3 font-semibold" href="/">
            <span className="grid size-9 place-items-center rounded-xl bg-red-600">
              ▶
            </span>
            YouTubeClone
          </Link>
          <nav className="hidden gap-5 text-sm text-zinc-400 md:flex">
            <Link className="hover:text-white" href="/">
              Home
            </Link>
            <Link className="hover:text-white" href="/subscriptions">
              Subscriptions
            </Link>
            <Link className="hover:text-white" href="/history">
              History
            </Link>
            <Link className="hover:text-white" href="/studio">
              Studio
            </Link>
            <Link className="hover:text-white" href="/studio/upload">
              Upload
            </Link>
          </nav>
        </div>
        <AuthStatus />
      </div>
    </header>
  );
}

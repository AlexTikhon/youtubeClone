'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

export function SearchForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  useEffect(() => setQuery(urlQuery), [urlQuery]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = query.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!normalized) return;
    router.push(`/search?q=${encodeURIComponent(normalized)}`);
  };

  return (
    <form
      aria-label="Video search"
      className="flex min-w-0 flex-1"
      onSubmit={submit}
    >
      <input
        aria-label="Search videos"
        className="min-w-0 flex-1 rounded-l-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm outline-none focus:border-red-500"
        maxLength={160}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search videos..."
        value={query}
      />
      <button
        aria-label="Submit search"
        className="rounded-r-full border border-l-0 border-zinc-700 bg-zinc-800 px-4 hover:bg-zinc-700"
        type="submit"
      >
        Search
      </button>
    </form>
  );
}

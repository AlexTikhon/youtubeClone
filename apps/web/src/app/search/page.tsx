import { SearchResults } from '@/widgets/search-results/search-results';
import type { Metadata } from 'next';

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}): Promise<Metadata> {
  const { q } = await searchParams;
  const query = (q ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
  return {
    title: query ? `Search: ${query} | YouTubeClone` : 'Search | YouTubeClone',
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <h1 className="mb-8 text-3xl font-bold">
        {query ? `Search results for “${query}”` : 'Search'}
      </h1>
      <SearchResults query={query} />
    </div>
  );
}

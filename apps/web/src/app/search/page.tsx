import { SearchResults } from '@/widgets/search-results/search-results';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
      <h1 className="mb-8 text-3xl font-bold">
        {query ? `Search results for “${query}”` : 'Search'}
      </h1>
      <SearchResults query={query} />
    </main>
  );
}

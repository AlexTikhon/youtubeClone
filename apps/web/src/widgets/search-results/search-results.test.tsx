import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/shared/api/api-client';
import { SearchResults } from './search-results';

vi.mock('@/shared/api/api-client', () => ({
  apiRequest: vi.fn(),
  resolveApiUrl: (path: string) => path,
}));

function renderResults(query: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SearchResults query={query} />
    </QueryClientProvider>,
  );
}

describe('SearchResults', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());
  afterEach(() => cleanup());
  it('shows a prompt for an empty URL query', () => {
    renderResults('');
    expect(screen.getByText(/enter a search term/i)).toBeInTheDocument();
  });
  it('renders returned video results', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      data: [
        {
          id: 'video',
          title: 'React Architecture',
          durationSeconds: 30,
          thumbnailUrl: null,
          viewsCount: 4,
          publishedAt: '2026-01-01T00:00:00.000Z',
          channel: {
            id: 'channel',
            name: 'Creator',
            handle: 'creator',
            avatarUrl: null,
          },
        },
      ],
      page: { hasMore: false, nextCursor: null },
    });
    renderResults('react');
    expect(await screen.findAllByText('React Architecture')).not.toHaveLength(
      0,
    );
  });
});

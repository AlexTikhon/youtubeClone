import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/shared/api/api-client';
import { ApiClientError } from '@/shared/api/api-error';
import { VideoFeed } from './video-feed';

vi.mock('@/shared/api/api-client', () => ({
  apiRequest: vi.fn(),
  resolveApiUrl: (path: string) => path,
}));

function renderFeed(error?: Error) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (error) {
    const key = ['feed', 'home'] as const;
    client.setQueryDefaults(key, { enabled: false });
    client.setQueryData(key, { pages: [], pageParams: [] });
    const cached = client.getQueryCache().find({ queryKey: key })!;
    cached.setState({
      ...cached.state,
      data: undefined,
      error,
      errorUpdateCount: 1,
      fetchStatus: 'idle',
      status: 'error',
    });
  }
  render(
    <QueryClientProvider client={client}>
      <VideoFeed
        emptyMessage="Nothing to watch yet."
        endpoint="/api/v1/feeds/home"
        queryKey={['feed', 'home']}
      />
    </QueryClientProvider>,
  );
}

describe('VideoFeed async states', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());
  afterEach(() => cleanup());

  it('renders a meaningful empty state', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      data: [],
      page: { hasMore: false, nextCursor: null },
    });
    renderFeed();
    expect(
      await screen.findByRole('heading', { name: 'Nothing to watch yet.' }),
    ).toBeInTheDocument();
  });

  it('offers retry when loading fails', async () => {
    renderFeed(
      new ApiClientError('private server detail', 503, 'SERVICE_ERROR'),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service is temporarily unavailable.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
});

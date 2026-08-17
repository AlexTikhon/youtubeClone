import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/shared/api/api-client';
import { ApiClientError } from '@/shared/api/api-error';
import { CommentsSection } from './comments-section';

vi.mock('@/shared/api/api-client', () => ({ apiRequest: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function renderComments(error?: Error) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (error) {
    const key = ['video', 'video-id', 'comments'] as const;
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
      <CommentsSection commentsCount={0} videoId="video-id" />
    </QueryClientProvider>,
  );
}

describe('CommentsSection async states', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());
  afterEach(() => cleanup());

  it('renders an accessible empty state and labelled form control', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      data: [],
      page: { hasMore: false, nextCursor: null },
    });
    renderComments();
    expect(
      await screen.findByRole('heading', { name: 'No comments yet' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Add comment')).toBeVisible();
  });

  it('offers a retry after a query error', async () => {
    renderComments(new ApiClientError('offline', 0, 'NETWORK_ERROR'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load comments.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
});

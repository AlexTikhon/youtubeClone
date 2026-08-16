import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/shared/api/api-client';
import { RelatedVideos } from './related-videos';

vi.mock('@/shared/api/api-client', () => ({
  apiRequest: vi.fn(),
  resolveApiUrl: (path: string) => path,
}));

describe('RelatedVideos', () => {
  it('renders a related video link', async () => {
    vi.mocked(apiRequest).mockResolvedValue([
      {
        id: 'related-id',
        title: 'Related Video',
        durationSeconds: 40,
        thumbnailUrl: null,
        viewsCount: 2,
        publishedAt: '2026-01-01T00:00:00.000Z',
        channel: {
          id: 'channel',
          name: 'Creator',
          handle: 'creator',
          avatarUrl: null,
        },
      },
    ]);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RelatedVideos videoId="current-id" />
      </QueryClientProvider>,
    );
    expect(
      (await screen.findAllByRole('link', { name: /Related Video/ }))[0],
    ).toHaveAttribute('href', '/watch/related-id');
  });
});

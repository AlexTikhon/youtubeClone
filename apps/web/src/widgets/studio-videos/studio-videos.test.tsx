import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StudioVideos } from './studio-videos';
import { apiRequest } from '@/shared/api/api-client';

vi.mock('@/shared/api/api-client', () => ({
  apiRequest: vi.fn(),
  resolveApiUrl: (value: string) => value,
}));

const failedVideo = {
  id: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
  title: 'Recoverable upload',
  description: null,
  status: 'FAILED' as const,
  visibility: 'PRIVATE' as const,
  durationSeconds: null,
  width: null,
  height: null,
  thumbnailUrl: null,
  playbackUrl: null,
  failureReason: 'The video could not be transcoded',
  processingGeneration: 1,
  processingStartedAt: '2026-08-16T10:00:00.000Z',
  processingFinishedAt: '2026-08-16T10:01:00.000Z',
  updatedAt: '2026-08-16T10:01:00.000Z',
  channel: { name: 'Owner', handle: 'owner' },
  publishedAt: null,
  createdAt: '2026-08-16T09:00:00.000Z',
  viewsCount: 0,
  likesCount: 0,
  commentsCount: 0,
};

describe('StudioVideos processing recovery', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows failed processing, disables retry while pending, and invalidates Studio', async () => {
    let resolveRetry!: () => void;
    const retryRequest = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    vi.mocked(apiRequest).mockImplementation((path: string) => {
      if (path.includes('retry-processing')) return retryRequest;
      return Promise.resolve({
        data: [failedVideo],
        page: { nextCursor: null, hasMore: false },
      });
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <QueryClientProvider client={queryClient}>
        <StudioVideos />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Processing failed')).toBeInTheDocument();
    expect(
      screen.getByText('The video could not be transcoded'),
    ).toBeInTheDocument();
    const retryButton = screen.getByRole('button', {
      name: 'Retry processing',
    });
    fireEvent.click(retryButton);

    expect(
      await screen.findByRole('button', { name: 'Retrying…' }),
    ).toBeDisabled();
    expect(apiRequest).toHaveBeenCalledWith(
      `/api/v1/videos/${failedVideo.id}/retry-processing`,
      { method: 'POST' },
    );

    resolveRetry();
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ['studio', 'videos'],
      }),
    );
  });
});

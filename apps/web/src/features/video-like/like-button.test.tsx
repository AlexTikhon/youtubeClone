import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WatchVideoDto } from '@youtube-clone/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/shared/api/api-client';
import { LikeButton, optimisticLikeState } from './like-button';

vi.mock('@/shared/api/api-client', () => ({ apiRequest: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const video: WatchVideoDto = {
  id: 'video-1',
  title: 'Test',
  description: null,
  durationSeconds: 60,
  playbackUrl: '/stream',
  publishedAt: '2026-01-01T00:00:00Z',
  viewsCount: 1,
  likesCount: 4,
  commentsCount: 0,
  likedByCurrentUser: false,
  resumePositionSeconds: null,
  channel: {
    id: 'channel',
    handle: 'channel',
    name: 'Channel',
    avatarUrl: null,
    subscribersCount: 0,
    subscribedByCurrentUser: false,
  },
};

describe('LikeButton optimistic update', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());
  it('updates immediately while retaining the prior value for rollback', async () => {
    let resolveRequest!: (value: {
      liked: boolean;
      likesCount: number;
    }) => void;
    vi.mocked(apiRequest).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    client.setQueryData(['video', video.id], video);
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    function BoundButton() {
      const current = client.getQueryData<WatchVideoDto>(['video', video.id])!;
      return <LikeButton video={current} />;
    }
    render(<BoundButton />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Like 4' }));
    await waitFor(() =>
      expect(
        client.getQueryData<WatchVideoDto>(['video', video.id]),
      ).toMatchObject({ likedByCurrentUser: true, likesCount: 5 }),
    );
    expect(video).toMatchObject({ likedByCurrentUser: false, likesCount: 4 });
    resolveRequest({ liked: true, likesCount: 5 });
    await waitFor(() =>
      expect(
        client.getQueryData<WatchVideoDto>(['video', video.id]),
      ).toMatchObject({ likedByCurrentUser: true, likesCount: 5 }),
    );
  });

  it('produces the inverse state used by optimistic update and rollback', () => {
    expect(optimisticLikeState(video)).toMatchObject({
      likedByCurrentUser: true,
      likesCount: 5,
    });
    expect(optimisticLikeState(optimisticLikeState(video))).toMatchObject({
      likedByCurrentUser: false,
      likesCount: 4,
    });
  });
});

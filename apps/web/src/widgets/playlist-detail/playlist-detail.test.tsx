import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/shared/api/api-client';
import { PlaylistDetail } from './playlist-detail';

vi.mock('@/shared/api/api-client', () => ({
  apiRequest: vi.fn(),
  resolveApiUrl: (path: string) => path,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('PlaylistDetail', () => {
  it('preserves playlist context in video navigation', async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      id: 'playlist-id',
      title: 'React Learning',
      description: null,
      visibility: 'PUBLIC',
      type: 'STANDARD',
      owner: { id: 'owner', username: 'creator' },
      ownedByCurrentUser: false,
      videoCount: 1,
      videos: [
        {
          position: 1,
          addedAt: '2026-01-01T00:00:00.000Z',
          video: {
            id: 'video-id',
            title: 'React Video',
            durationSeconds: 30,
            thumbnailUrl: null,
            viewsCount: 1,
            publishedAt: '2026-01-01T00:00:00.000Z',
            channel: {
              id: 'channel',
              name: 'Creator',
              handle: 'creator',
              avatarUrl: null,
            },
          },
        },
      ],
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PlaylistDetail playlistId="playlist-id" />
      </QueryClientProvider>,
    );
    const links = await screen.findAllByRole('link', { name: /React Video/ });
    expect(links[0]).toHaveAttribute(
      'href',
      '/watch/video-id?list=playlist-id',
    );
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from '@/shared/api/api-client';
import { SaveToPlaylistButton } from './save-to-playlist-button';

vi.mock('@/shared/api/api-client', () => ({ apiRequest: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('SaveToPlaylistButton', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('loads Watch Later and saves with the idempotent playlist endpoint', async () => {
    vi.mocked(apiRequest).mockImplementation(async (path) => {
      if (typeof path === 'string' && path.includes('/playlists/mine')) {
        return {
          data: [
            {
              id: 'playlist-id',
              title: 'Watch Later',
              description: null,
              visibility: 'PRIVATE',
              type: 'WATCH_LATER',
              videoCount: 0,
              coverThumbnailUrl: null,
              updatedAt: '2026-01-01T00:00:00.000Z',
              containsVideo: false,
            },
          ],
          page: { hasMore: false, nextCursor: null },
        };
      }
      return { saved: true };
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SaveToPlaylistButton videoId="video-id" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        '/api/v1/playlists/playlist-id/videos/video-id',
        { method: 'PUT' },
      ),
    );
  });
});

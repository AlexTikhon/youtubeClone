import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from '@/shared/api/api-client';

import { WatchVideo } from './watch-video';

vi.mock('@/shared/api/api-client', () => ({
  apiRequest: vi.fn(),
  resolveApiUrl: (value: string) => value,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/shared/query/use-current-user', () => ({
  useCurrentUser: () => ({
    data: { id: 'viewer', channel: { id: 'viewer-channel' } },
  }),
}));
vi.mock('@/widgets/comments-section/comments-section', () => ({
  CommentsSection: () => null,
}));
vi.mock('@/widgets/related-videos/related-videos', () => ({
  RelatedVideos: () => null,
}));
vi.mock('@/widgets/playlist-panel/playlist-panel', () => ({
  PlaylistPanel: () => null,
}));
vi.mock('@/features/playlist-save/save-to-playlist-button', () => ({
  SaveToPlaylistButton: () => null,
}));
vi.mock('@/features/video-like/like-button', () => ({
  LikeButton: () => null,
}));

const videoId = 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0';
const detail = (resumePositionSeconds: number | null) => ({
  id: videoId,
  title: 'Watch',
  visibility: 'PUBLIC',
  description: null,
  durationSeconds: 300,
  playbackUrl: `/api/v1/media/videos/${videoId}/hls/master.m3u8`,
  publishedAt: null,
  viewsCount: 1,
  likesCount: 0,
  commentsCount: 0,
  likedByCurrentUser: false,
  channel: {
    id: 'channel',
    handle: 'channel',
    name: 'Channel',
    avatarUrl: null,
    subscribersCount: 1,
    subscribedByCurrentUser: false,
  },
  resumePositionSeconds,
});

describe('WatchVideo playback during metadata refetches', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue(
      'maybe',
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('leaves active playback uninterrupted when a subscription refetches watch metadata', async () => {
    const load = vi
      .spyOn(HTMLMediaElement.prototype, 'load')
      .mockImplementation(() => undefined);
    let detailRequests = 0;
    vi.mocked(apiRequest).mockImplementation((path: string, options) => {
      if (path === `/api/v1/videos/${videoId}`) {
        detailRequests += 1;
        // The refetch reports a much older saved position.
        return Promise.resolve(detail(detailRequests === 1 ? 120 : 6));
      }
      if (path.endsWith('/subscription') && options?.method === 'PUT')
        return Promise.resolve({ subscribed: true, subscriberCount: 2 });
      return Promise.resolve({});
    });
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <WatchVideo videoId={videoId} />
      </QueryClientProvider>,
    );
    const video = (await screen.findByLabelText(
      'Video player',
    )) as HTMLVideoElement;
    const writes: number[] = [];
    let current = 0;
    Object.defineProperty(video, 'duration', {
      configurable: true,
      value: 300,
    });
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => current,
      set: (value: number) => {
        writes.push(value);
        current = value;
      },
    });
    fireEvent.loadedMetadata(video);
    current = 200;
    fireEvent.timeUpdate(video);
    expect(writes).toEqual([120]);
    const loadsBefore = load.mock.calls.length;
    const sourceBefore = video.getAttribute('src');

    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() => expect(detailRequests).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByLabelText('Video player')).toBe(video);
    expect(load.mock.calls.length).toBe(loadsBefore);
    expect(video.getAttribute('src')).toBe(sourceBefore);
    expect(writes).toEqual([120]);
    expect(video.currentTime).toBe(200);
  });
});

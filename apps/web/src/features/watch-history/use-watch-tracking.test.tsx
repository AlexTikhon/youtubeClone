import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from '@/shared/api/api-client';
import { useWatchTracking } from './use-watch-tracking';

vi.mock('@/shared/api/api-client', () => ({ apiRequest: vi.fn() }));

describe('useWatchTracking', () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset().mockResolvedValue({
      counted: true,
      viewsCount: 1,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('starts a fresh qualified-view session when the route video changes', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ videoId }) => useWatchTracking(videoId, 2, true),
      { initialProps: { videoId: 'video-one' }, wrapper },
    );

    act(() => {
      result.current.onProgress({ positionSeconds: 0, durationSeconds: 2 });
      result.current.onProgress({ positionSeconds: 1, durationSeconds: 2 });
    });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        '/api/v1/videos/video-one/view',
        expect.any(Object),
      ),
    );

    rerender({ videoId: 'video-two' });
    act(() => {
      result.current.onProgress({ positionSeconds: 0, durationSeconds: 2 });
      result.current.onProgress({ positionSeconds: 1, durationSeconds: 2 });
    });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        '/api/v1/videos/video-two/view',
        expect.any(Object),
      ),
    );
  });

  it('throttles progress writes and flushes the latest position on page hide', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useWatchTracking('video-one', 60, true),
      { wrapper },
    );

    act(() => {
      result.current.onProgress({ positionSeconds: 0, durationSeconds: 60 });
      result.current.onProgress({ positionSeconds: 1, durationSeconds: 60 });
      result.current.onProgress({ positionSeconds: 2, durationSeconds: 60 });
    });
    expect(
      vi
        .mocked(apiRequest)
        .mock.calls.filter(([path]) => String(path).endsWith('/history')),
    ).toHaveLength(0);

    now = 14_000;
    act(() => {
      result.current.onProgress({ positionSeconds: 3, durationSeconds: 60 });
    });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        '/api/v1/videos/video-one/history',
        expect.objectContaining({
          body: { positionSeconds: 3 },
          keepalive: false,
        }),
      ),
    );

    now = 15_000;
    act(() => {
      result.current.onProgress({ positionSeconds: 5, durationSeconds: 60 });
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        '/api/v1/videos/video-one/history',
        expect.objectContaining({
          body: { positionSeconds: 5 },
          keepalive: true,
        }),
      ),
    );
  });
});

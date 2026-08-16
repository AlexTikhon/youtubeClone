import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});

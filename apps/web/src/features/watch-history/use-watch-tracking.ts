'use client';
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/shared/api/api-client';
import type { PlayerProgress } from '@/features/video-player/hls-video-player';

export function useWatchTracking(
  videoId: string,
  durationSeconds: number,
  authenticated: boolean,
) {
  const queryClient = useQueryClient();
  const watched = useRef(0);
  const previousPosition = useRef<number | null>(null);
  const lastSavedAt = useRef(0);
  const viewSent = useRef(false);
  const save = useCallback(
    (positionSeconds: number) => {
      if (!authenticated) return;
      lastSavedAt.current = Date.now();
      void apiRequest(`/api/v1/videos/${videoId}/history`, {
        method: 'PUT',
        body: { positionSeconds },
      })
        .then(() => queryClient.invalidateQueries({ queryKey: ['history'] }))
        .catch(() => undefined);
    },
    [authenticated, queryClient, videoId],
  );
  const onProgress = useCallback(
    (progress: PlayerProgress) => {
      const previous = previousPosition.current;
      const delta = previous === null ? 0 : progress.positionSeconds - previous;
      if (delta > 0 && delta < 2) watched.current += delta;
      previousPosition.current = progress.positionSeconds;
      const threshold = Math.min(10, Math.max(1, durationSeconds * 0.5));
      if (authenticated && !viewSent.current && watched.current >= threshold) {
        viewSent.current = true;
        void apiRequest<{ counted: boolean; viewsCount: number }>(
          `/api/v1/videos/${videoId}/view`,
          { method: 'POST', body: { watchedSeconds: watched.current } },
        )
          .then(() =>
            queryClient.invalidateQueries({ queryKey: ['video', videoId] }),
          )
          .catch(() => {
            viewSent.current = false;
          });
      }
      if (authenticated && Date.now() - lastSavedAt.current >= 12_000)
        save(progress.positionSeconds);
    },
    [authenticated, durationSeconds, queryClient, save, videoId],
  );
  useEffect(() => {
    const pageHide = () => {
      if (previousPosition.current !== null) save(previousPosition.current);
    };
    window.addEventListener('pagehide', pageHide);
    return () => window.removeEventListener('pagehide', pageHide);
  }, [save]);
  return {
    onProgress,
    onPause: (progress: PlayerProgress) => save(progress.positionSeconds),
    onEnded: (progress: PlayerProgress) => save(progress.durationSeconds),
  };
}

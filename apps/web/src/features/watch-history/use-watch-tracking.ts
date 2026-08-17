'use client';
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/shared/api/api-client';
import type { PlayerProgress } from '@/features/video-player/hls-video-player';
import { queryKeys } from '@/shared/query/query-keys';

export function useWatchTracking(
  videoId: string,
  durationSeconds: number,
  authenticated: boolean,
) {
  const queryClient = useQueryClient();
  const watched = useRef(0);
  const previousPosition = useRef<number | null>(null);
  const lastSavedPosition = useRef<number | null>(null);
  const lastSavedAt = useRef(Date.now());
  const viewSent = useRef(false);
  useEffect(() => {
    watched.current = 0;
    previousPosition.current = null;
    lastSavedPosition.current = null;
    lastSavedAt.current = Date.now();
    viewSent.current = false;
  }, [videoId]);
  const save = useCallback(
    (positionSeconds: number, keepalive = false) => {
      if (!authenticated) return;
      if (
        lastSavedPosition.current !== null &&
        Math.abs(positionSeconds - lastSavedPosition.current) < 1
      ) {
        return;
      }
      const previousSavedPosition = lastSavedPosition.current;
      lastSavedPosition.current = positionSeconds;
      lastSavedAt.current = Date.now();
      void apiRequest(`/api/v1/videos/${videoId}/history`, {
        method: 'PUT',
        keepalive,
        body: { positionSeconds },
      })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: queryKeys.history.all }),
        )
        .catch(() => {
          if (lastSavedPosition.current === positionSeconds)
            lastSavedPosition.current = previousSavedPosition;
        });
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
            queryClient.invalidateQueries({
              queryKey: queryKeys.video.detail(videoId),
            }),
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
    const flush = () => {
      if (previousPosition.current !== null)
        save(previousPosition.current, true);
    };
    const visibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', visibilityChange);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', visibilityChange);
    };
  }, [save]);
  return {
    onProgress,
    onPause: (progress: PlayerProgress) => save(progress.positionSeconds),
    onEnded: (progress: PlayerProgress) => save(progress.durationSeconds),
  };
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { resolveApiUrl } from '@/shared/api/api-client';

export interface PlayerProgress {
  positionSeconds: number;
  durationSeconds: number;
}

interface PlayerProps {
  playbackUrl: string;
  initialPositionSeconds?: number | null;
  onProgress?: (progress: PlayerProgress) => void;
  onPlay?: () => void;
  onPause?: (progress: PlayerProgress) => void;
  onEnded?: (progress: PlayerProgress) => void;
}

type PlayerState = 'loading' | 'ready' | 'playing' | 'error';

const MAX_NETWORK_RECOVERY_ATTEMPTS = 2;
const MAX_MEDIA_RECOVERY_ATTEMPTS = 1;

export function HlsVideoPlayer({
  playbackUrl,
  initialPositionSeconds,
  onProgress,
  onPlay,
  onPause,
  onEnded,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onProgress, onPlay, onPause, onEnded });
  const [playerState, setPlayerState] = useState<PlayerState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  callbacks.current = { onProgress, onPlay, onPause, onEnded };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const media = video;
    let disposed = false;
    let destroyHls: (() => void) | undefined;
    const source = resolveApiUrl(playbackUrl);
    setPlayerState('loading');
    setErrorMessage(null);

    const progress = () => ({
      positionSeconds: video.currentTime,
      durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
    });
    const loaded = () => {
      if (
        initialPositionSeconds &&
        initialPositionSeconds < video.duration - 1
      ) {
        video.currentTime = initialPositionSeconds;
      }
    };
    const canPlay = () => setPlayerState('ready');
    const waiting = () =>
      setPlayerState((state) => (state === 'error' ? state : 'loading'));
    const time = () => callbacks.current.onProgress?.(progress());
    const play = () => {
      setPlayerState('playing');
      callbacks.current.onPlay?.();
    };
    const pause = () => {
      setPlayerState((state) => (state === 'error' ? state : 'ready'));
      callbacks.current.onPause?.(progress());
    };
    const ended = () => callbacks.current.onEnded?.(progress());
    const mediaError = () => {
      setPlayerState('error');
      const messages: Partial<Record<number, string>> = {
        2: 'Playback stopped because the video stream could not be loaded.',
        3: 'Playback stopped because the video could not be decoded.',
        4: 'This browser does not support the video format.',
      };
      setErrorMessage(
        messages[video.error?.code ?? 0] ?? 'Playback stopped unexpectedly.',
      );
    };
    video.addEventListener('loadedmetadata', loaded);
    video.addEventListener('canplay', canPlay);
    video.addEventListener('waiting', waiting);
    video.addEventListener('timeupdate', time);
    video.addEventListener('play', play);
    video.addEventListener('pause', pause);
    video.addEventListener('ended', ended);
    video.addEventListener('error', mediaError);

    async function attachSource() {
      if (media.canPlayType('application/vnd.apple.mpegurl')) {
        media.src = source;
        media.load();
        return;
      }
      try {
        const { default: Hls } = await import('hls.js');
        if (disposed) return;
        if (!Hls.isSupported()) {
          setPlayerState('error');
          setErrorMessage('This browser does not support HLS video playback.');
          return;
        }
        let networkRecoveryAttempts = 0;
        let mediaRecoveryAttempts = 0;
        const hls = new Hls({
          xhrSetup: (request) => {
            request.withCredentials = true;
          },
        });
        destroyHls = () => hls.destroy();
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || disposed) return;
          if (
            data.type === Hls.ErrorTypes.NETWORK_ERROR &&
            networkRecoveryAttempts < MAX_NETWORK_RECOVERY_ATTEMPTS
          ) {
            networkRecoveryAttempts += 1;
            setPlayerState('loading');
            hls.startLoad();
            return;
          }
          if (
            data.type === Hls.ErrorTypes.MEDIA_ERROR &&
            mediaRecoveryAttempts < MAX_MEDIA_RECOVERY_ATTEMPTS
          ) {
            mediaRecoveryAttempts += 1;
            setPlayerState('loading');
            hls.recoverMediaError();
            return;
          }
          setPlayerState('error');
          setErrorMessage(
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? 'The video stream could not be loaded after retrying.'
              : 'The browser could not continue playing this video.',
          );
          hls.stopLoad();
        });
        hls.loadSource(source);
        hls.attachMedia(media);
      } catch {
        if (!disposed) {
          setPlayerState('error');
          setErrorMessage('The video player could not be initialized.');
        }
      }
    }

    void attachSource();
    return () => {
      disposed = true;
      video.removeEventListener('loadedmetadata', loaded);
      video.removeEventListener('canplay', canPlay);
      video.removeEventListener('waiting', waiting);
      video.removeEventListener('timeupdate', time);
      video.removeEventListener('play', play);
      video.removeEventListener('pause', pause);
      video.removeEventListener('ended', ended);
      video.removeEventListener('error', mediaError);
      destroyHls?.();
      video.removeAttribute('src');
      video.load();
    };
  }, [initialPositionSeconds, playbackUrl, retryGeneration]);

  return (
    <div
      aria-busy={playerState === 'loading'}
      className="relative aspect-video w-full bg-black"
    >
      <video
        aria-label="Video player"
        className="h-full w-full"
        controls
        crossOrigin="use-credentials"
        playsInline
        ref={videoRef}
      />
      {playerState === 'loading' && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-0 grid place-items-center bg-zinc-950/80 text-sm text-zinc-300"
          role="status"
        >
          Preparing video…
        </div>
      )}
      {playerState === 'error' && (
        <div
          className="absolute inset-0 grid place-items-center bg-zinc-950/95 p-6 text-center"
          role="alert"
        >
          <div>
            <p className="text-sm text-red-200">
              {errorMessage ?? 'Playback is unavailable.'}
            </p>
            <button
              className="mt-4 rounded-lg bg-red-600 px-4 py-2 font-semibold"
              onClick={() => setRetryGeneration((value) => value + 1)}
              type="button"
            >
              Retry playback
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

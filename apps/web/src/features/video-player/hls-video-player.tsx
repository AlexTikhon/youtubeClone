'use client';

import Hls from 'hls.js';
import { useEffect, useRef } from 'react';
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
  callbacks.current = { onProgress, onPlay, onPause, onEnded };
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const source = resolveApiUrl(playbackUrl);
    const progress = () => ({
      positionSeconds: video.currentTime,
      durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
    });
    const loaded = () => {
      if (initialPositionSeconds) video.currentTime = initialPositionSeconds;
    };
    const time = () => callbacks.current.onProgress?.(progress());
    const play = () => callbacks.current.onPlay?.();
    const pause = () => callbacks.current.onPause?.(progress());
    const ended = () => callbacks.current.onEnded?.(progress());
    video.addEventListener('loadedmetadata', loaded);
    video.addEventListener('timeupdate', time);
    video.addEventListener('play', play);
    video.addEventListener('pause', pause);
    video.addEventListener('ended', ended);
    let hls: Hls | undefined;
    if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = source;
    else if (Hls.isSupported()) {
      hls = new Hls({
        xhrSetup: (request) => {
          request.withCredentials = true;
        },
      });
      hls.loadSource(source);
      hls.attachMedia(video);
    }
    return () => {
      video.removeEventListener('loadedmetadata', loaded);
      video.removeEventListener('timeupdate', time);
      video.removeEventListener('play', play);
      video.removeEventListener('pause', pause);
      video.removeEventListener('ended', ended);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [playbackUrl, initialPositionSeconds]);
  return (
    <video
      aria-label="Video player"
      className="aspect-video w-full bg-black"
      controls
      crossOrigin="use-credentials"
      playsInline
      ref={videoRef}
    />
  );
}

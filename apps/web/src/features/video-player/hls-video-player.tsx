'use client';

import Hls from 'hls.js';
import { useEffect, useRef } from 'react';

import { resolveApiUrl } from '@/shared/api/api-client';

export function HlsVideoPlayer({ playbackUrl }: { playbackUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const source = resolveApiUrl(playbackUrl);
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source;
      return () => {
        video.removeAttribute('src');
        video.load();
      };
    }
    if (!Hls.isSupported()) return;
    const hls = new Hls({
      xhrSetup: (request) => {
        request.withCredentials = true;
      },
    });
    hls.loadSource(source);
    hls.attachMedia(video);
    return () => {
      hls.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [playbackUrl]);
  return (
    <video
      className="aspect-video w-full bg-black"
      controls
      crossOrigin="use-credentials"
      playsInline
      ref={videoRef}
    />
  );
}

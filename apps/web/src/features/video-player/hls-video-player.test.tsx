import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HlsVideoPlayer } from './hls-video-player';

describe('HlsVideoPlayer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows loading, becomes ready, and offers playback retry on media error', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue(
      'maybe',
    );
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
      () => undefined,
    );
    render(<HlsVideoPlayer playbackUrl="/stream/master.m3u8" />);

    expect(screen.getByRole('status')).toHaveTextContent('Preparing video');
    const video = screen.getByLabelText('Video player');
    fireEvent.canPlay(video);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 3 },
    });
    fireEvent.error(video);
    expect(screen.getByRole('alert')).toHaveTextContent('could not be decoded');
    expect(
      screen.getByRole('button', { name: 'Retry playback' }),
    ).toBeEnabled();
  });
});

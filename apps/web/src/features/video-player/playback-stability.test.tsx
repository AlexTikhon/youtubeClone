import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HlsVideoPlayer } from './hls-video-player';

const hlsInstances: FakeHls[] = [];

class FakeHls {
  static isSupported = () => true;
  static Events = { ERROR: 'hlsError' };
  static ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
  };
  config: { xhrSetup?: (request: { withCredentials: boolean }) => void };
  destroyed = false;
  source = '';
  constructor(config: FakeHls['config']) {
    this.config = config;
    hlsInstances.push(this);
  }
  on = vi.fn();
  loadSource = vi.fn((source: string) => {
    this.source = source;
  });
  attachMedia = vi.fn();
  startLoad = vi.fn();
  stopLoad = vi.fn();
  recoverMediaError = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
}

vi.mock('hls.js', () => ({ default: FakeHls }));

/** Replaces currentTime/duration on the element so seeks can be observed. */
function instrument(video: HTMLVideoElement, duration = 100) {
  const writes: number[] = [];
  let current = 0;
  Object.defineProperty(video, 'duration', {
    configurable: true,
    value: duration,
  });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => current,
    set: (value: number) => {
      writes.push(value);
      current = value;
    },
  });
  return {
    writes,
    playTo(seconds: number) {
      current = seconds;
      fireEvent.timeUpdate(video);
    },
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe.each([
  ['native HLS', 'maybe'],
  ['hls.js', ''],
])('HlsVideoPlayer playback stability (%s)', (_name, canPlayType) => {
  let load: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    hlsInstances.length = 0;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue(
      canPlayType as CanPlayTypeResult,
    );
    load = vi
      .spyOn(HTMLMediaElement.prototype, 'load')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('applies the initial resume once when the source attaches', async () => {
    render(
      <HlsVideoPlayer
        initialPositionSeconds={30}
        playbackUrl="/v/1/master.m3u8"
      />,
    );
    await settle();
    const video = screen.getByLabelText('Video player') as HTMLVideoElement;
    const probe = instrument(video);

    fireEvent.loadedMetadata(video);

    expect(probe.writes).toEqual([30]);
  });

  it('does not reload, destroy, or seek when only the resume metadata changes', async () => {
    const { rerender } = render(
      <HlsVideoPlayer
        initialPositionSeconds={30}
        playbackUrl="/v/1/master.m3u8"
      />,
    );
    await settle();
    const video = screen.getByLabelText('Video player') as HTMLVideoElement;
    const probe = instrument(video);
    fireEvent.loadedMetadata(video);
    probe.playTo(75);
    const loadsBefore = load.mock.calls.length;
    const writesBefore = probe.writes.length;

    // A watch-detail refetch reports an older saved position.
    rerender(
      <HlsVideoPlayer
        initialPositionSeconds={12}
        playbackUrl="/v/1/master.m3u8"
      />,
    );
    rerender(
      <HlsVideoPlayer
        initialPositionSeconds={null}
        playbackUrl="/v/1/master.m3u8"
      />,
    );
    await settle();
    fireEvent.loadedMetadata(video);

    expect(load.mock.calls.length).toBe(loadsBefore);
    expect(probe.writes.length).toBe(writesBefore);
    expect(video.currentTime).toBe(75);
    expect(hlsInstances.filter((instance) => instance.destroyed)).toHaveLength(
      0,
    );
    expect(hlsInstances.length).toBe(canPlayType ? 0 : 1);
  });

  it('resets playback and applies the new source’s own resume when the source changes', async () => {
    const { rerender } = render(
      <HlsVideoPlayer
        initialPositionSeconds={30}
        playbackUrl="/v/1/master.m3u8"
      />,
    );
    await settle();
    const video = screen.getByLabelText('Video player') as HTMLVideoElement;
    const probe = instrument(video);
    fireEvent.loadedMetadata(video);
    probe.playTo(75);
    const loadsBefore = load.mock.calls.length;

    rerender(
      <HlsVideoPlayer
        initialPositionSeconds={8}
        playbackUrl="/v/2/master.m3u8"
      />,
    );
    await settle();
    fireEvent.loadedMetadata(video);

    expect(load.mock.calls.length).toBeGreaterThan(loadsBefore);
    expect(probe.writes.at(-1)).toBe(8);
    if (!canPlayType) {
      expect(hlsInstances).toHaveLength(2);
      expect(hlsInstances[0]!.destroyed).toBe(true);
      expect(hlsInstances[1]!.source).toContain('/v/2/master.m3u8');
    }
  });

  it('rebuilds playback on explicit retry at the position reached, not the stale resume', async () => {
    render(
      <HlsVideoPlayer
        initialPositionSeconds={10}
        playbackUrl="/v/1/master.m3u8"
      />,
    );
    await settle();
    const video = screen.getByLabelText('Video player') as HTMLVideoElement;
    const probe = instrument(video);
    fireEvent.loadedMetadata(video);
    probe.playTo(42);
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 2 },
    });
    fireEvent.error(video);

    fireEvent.click(screen.getByRole('button', { name: 'Retry playback' }));
    await settle();
    fireEvent.loadedMetadata(video);

    expect(probe.writes.at(-1)).toBe(42);
    if (!canPlayType) {
      expect(hlsInstances).toHaveLength(2);
      expect(hlsInstances[0]!.destroyed).toBe(true);
    }
  });

  it('falls back to the initial resume on retry when nothing was played yet', async () => {
    render(
      <HlsVideoPlayer
        initialPositionSeconds={10}
        playbackUrl="/v/1/master.m3u8"
      />,
    );
    await settle();
    const video = screen.getByLabelText('Video player') as HTMLVideoElement;
    const probe = instrument(video);
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 2 },
    });
    fireEvent.error(video);

    fireEvent.click(screen.getByRole('button', { name: 'Retry playback' }));
    await settle();
    fireEvent.loadedMetadata(video);

    expect(probe.writes).toEqual([10]);
  });
});

describe('HlsVideoPlayer hls.js integration', () => {
  beforeEach(() => {
    hlsInstances.length = 0;
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(
      () => undefined,
    );
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('keeps credentialed requests and destroys hls.js on unmount', async () => {
    const { unmount } = render(
      <HlsVideoPlayer playbackUrl="/v/1/master.m3u8" />,
    );
    await settle();
    const request = { withCredentials: false };

    hlsInstances[0]!.config.xhrSetup?.(request);
    unmount();

    expect(request.withCredentials).toBe(true);
    expect(hlsInstances[0]!.attachMedia).toHaveBeenCalled();
    expect(hlsInstances[0]!.destroyed).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import {
  createMasterPlaylist,
  selectRenditions,
  type GeneratedRendition,
} from './hls-renditions.js';

describe('selectRenditions', () => {
  it.each([
    [1920, 1080, ['360p', '480p', '720p']],
    [1280, 720, ['360p', '480p', '720p']],
    [854, 480, ['360p', '480p']],
    [640, 360, ['360p']],
    [320, 240, ['source']],
  ] as const)(
    'selects a source-aware ladder for %ix%i',
    (width, height, names) => {
      expect(
        selectRenditions({ sourceWidth: width, sourceHeight: height }).map(
          (rendition) => rendition.name,
        ),
      ).toEqual(names);
    },
  );

  it('preserves landscape aspect ratio with even H.264 dimensions', () => {
    const renditions = selectRenditions({
      sourceWidth: 1920,
      sourceHeight: 1080,
    });
    expect(renditions.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 640, height: 360 },
      { width: 854, height: 480 },
      { width: 1280, height: 720 },
    ]);
  });

  it('preserves portrait orientation without crop or rotation', () => {
    const renditions = selectRenditions({
      sourceWidth: 1080,
      sourceHeight: 1920,
    });
    expect(renditions.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 202, height: 360 },
      { width: 270, height: 480 },
      { width: 406, height: 720 },
    ]);
  });

  it('emits one even, source-bounded rendition for a small odd source', () => {
    expect(
      selectRenditions({ sourceWidth: 321, sourceHeight: 241 }),
    ).toMatchObject([{ name: 'source', width: 320, height: 240 }]);
  });

  it('never upscales either dimension', () => {
    for (const [sourceWidth, sourceHeight] of [
      [641, 361],
      [333, 999],
      [2001, 481],
    ]) {
      for (const rendition of selectRenditions({
        sourceWidth,
        sourceHeight,
      })) {
        expect(rendition.width).toBeLessThanOrEqual(sourceWidth);
        expect(rendition.height).toBeLessThanOrEqual(sourceHeight);
        expect(rendition.width % 2).toBe(0);
        expect(rendition.height % 2).toBe(0);
      }
    }
  });

  it('does not advertise audio bandwidth for an audio-less source', () => {
    const [rendition] = selectRenditions({
      sourceWidth: 640,
      sourceHeight: 360,
      hasAudio: false,
    });
    expect(rendition).toMatchObject({
      audioBitrateKbps: 0,
      bandwidthBitsPerSecond: 880_000,
    });
  });
});

describe('createMasterPlaylist', () => {
  it('writes accurate bandwidth, resolution, and relative variant paths', () => {
    const generated: GeneratedRendition[] = selectRenditions({
      sourceWidth: 1280,
      sourceHeight: 720,
    }).map((spec) => ({
      spec,
      manifestPath: `ignored/${spec.name}/index.m3u8`,
      segmentCount: 1,
    }));

    const playlist = createMasterPlaylist(generated);
    expect(playlist.match(/#EXT-X-STREAM-INF:/g)).toHaveLength(3);
    expect(playlist).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=986000,RESOLUTION=640x360',
    );
    expect(playlist).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=1681000,RESOLUTION=854x480',
    );
    expect(playlist).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=3221000,RESOLUTION=1280x720',
    );
    expect(playlist).toContain('\n360p/index.m3u8\n');
    expect(playlist).toContain('\n480p/index.m3u8\n');
    expect(playlist).toContain('\n720p/index.m3u8\n');
    expect(playlist).not.toContain('http');
  });
});

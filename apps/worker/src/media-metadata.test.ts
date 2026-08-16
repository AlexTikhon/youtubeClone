import { describe, expect, it } from 'vitest';

import { fitWithin720p, parseProbeOutput } from './media-metadata.js';

describe('media metadata', () => {
  it('extracts stable metadata from ffprobe JSON', () => {
    expect(
      parseProbeOutput(
        JSON.stringify({
          format: {
            duration: '3.25',
            format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
            bit_rate: '800000',
          },
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 1920,
              height: 1080,
              r_frame_rate: '30000/1001',
            },
            { codec_type: 'audio', codec_name: 'aac' },
          ],
        }),
      ),
    ).toMatchObject({
      durationSeconds: 3.25,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitrateKbps: 800,
      rotationDegrees: 0,
    });
  });

  it('rejects a payload without a usable video stream', () => {
    expect(() =>
      parseProbeOutput(
        JSON.stringify({
          format: { duration: '2' },
          streams: [{ codec_type: 'audio', codec_name: 'aac' }],
        }),
      ),
    ).toThrow('usable video stream');
  });

  it('does not upscale and emits dimensions suitable for H.264', () => {
    expect(fitWithin720p(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin720p(641, 359)).toEqual({ width: 640, height: 358 });
  });

  it('uses display orientation for phone rotation metadata', () => {
    expect(
      parseProbeOutput(
        JSON.stringify({
          format: { duration: '2' },
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 1920,
              height: 1080,
              side_data_list: [{ rotation: -90 }],
            },
          ],
        }),
      ),
    ).toMatchObject({ width: 1080, height: 1920, rotationDegrees: -90 });
  });
});

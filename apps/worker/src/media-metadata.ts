import { ProcessingError } from './processing-error.js';

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface ProbePayload {
  format?: {
    duration?: string;
    format_name?: string;
    bit_rate?: string;
  };
  streams?: ProbeStream[];
}

export interface MediaMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  container: string;
  frameRate: number | null;
  bitrateKbps: number | null;
}

export function parseProbeOutput(output: string): MediaMetadata {
  let payload: ProbePayload;
  try {
    payload = JSON.parse(output) as ProbePayload;
  } catch (error) {
    throw new ProcessingError(
      'ffprobe returned invalid JSON',
      false,
      'The uploaded file is not a valid video',
      { cause: error },
    );
  }
  const video = payload.streams?.find(
    (stream) => stream.codec_type === 'video',
  );
  const audio = payload.streams?.find(
    (stream) => stream.codec_type === 'audio',
  );
  const durationSeconds = Number(payload.format?.duration);
  if (
    !video?.codec_name ||
    !video.width ||
    !video.height ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new ProcessingError(
      'ffprobe did not find a usable video stream',
      false,
      'The uploaded file is not a usable video',
    );
  }
  return {
    durationSeconds,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    container: payload.format?.format_name ?? 'unknown',
    frameRate: parseFrameRate(video.r_frame_rate),
    bitrateKbps: parseBitrate(payload.format?.bit_rate),
  };
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator = '1'] = value.split('/');
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : null;
}

function parseBitrate(value: string | undefined): number | null {
  const result = Number(value) / 1000;
  return Number.isFinite(result) && result > 0 ? Math.round(result) : null;
}

export function fitWithin720p(width: number, height: number) {
  const scale = Math.min(1, 1280 / width, 720 / height);
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

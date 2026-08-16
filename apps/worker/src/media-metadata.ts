import { ProcessingError } from './processing-error.js';

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
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
  rotationDegrees: number;
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
    video.width < 2 ||
    video.height < 2 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new ProcessingError(
      'ffprobe did not find a usable video stream',
      false,
      'The uploaded file is not a usable video',
    );
  }
  const rotationDegrees = parseRotation(video);
  const swapsDimensions = Math.abs(rotationDegrees) % 180 === 90;
  return {
    durationSeconds,
    width: swapsDimensions ? video.height : video.width,
    height: swapsDimensions ? video.width : video.height,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    container: payload.format?.format_name ?? 'unknown',
    frameRate: parseFrameRate(video.r_frame_rate),
    bitrateKbps: parseBitrate(payload.format?.bit_rate),
    rotationDegrees,
  };
}

function parseRotation(video: ProbeStream): number {
  const raw =
    video.side_data_list?.find((sideData) => Number.isFinite(sideData.rotation))
      ?.rotation ?? Number(video.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  const normalized = ((Math.round(raw) % 360) + 360) % 360;
  return normalized > 180 ? normalized - 360 : normalized;
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

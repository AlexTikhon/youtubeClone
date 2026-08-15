export const VIDEO_STATUSES = [
  'DRAFT',
  'UPLOADING',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

const ALLOWED_VIDEO_TRANSITIONS: Readonly<
  Record<VideoStatus, readonly VideoStatus[]>
> = {
  DRAFT: ['UPLOADING'],
  UPLOADING: ['UPLOADED', 'FAILED'],
  UPLOADED: ['PROCESSING', 'FAILED'],
  PROCESSING: ['READY', 'FAILED'],
  READY: ['PROCESSING'],
  FAILED: ['PROCESSING'],
};

export class InvalidVideoTransitionError extends Error {
  constructor(
    public readonly from: VideoStatus,
    public readonly to: VideoStatus,
  ) {
    super(`Video cannot transition from ${from} to ${to}`);
    this.name = 'InvalidVideoTransitionError';
  }
}

export function assertVideoTransition(
  from: VideoStatus,
  to: VideoStatus,
): void {
  if (!ALLOWED_VIDEO_TRANSITIONS[from].includes(to))
    throw new InvalidVideoTransitionError(from, to);
}

export const VIDEO_VISIBILITIES = ['PRIVATE', 'UNLISTED', 'PUBLIC'] as const;
export type VideoVisibility = (typeof VIDEO_VISIBILITIES)[number];

export interface ApiErrorDetail {
  code: string;
  message: string;
  requestId: string;
  details?: unknown;
}

export interface ApiErrorEnvelope {
  error: ApiErrorDetail;
}

export interface HealthDependency {
  status: 'up' | 'down';
  latencyMs?: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  service: 'api';
  timestamp: string;
  dependencies?: {
    postgres: HealthDependency;
    redis: HealthDependency;
  };
}

export interface VideoSummary {
  id: string;
  title: string;
  description: string | null;
  status: VideoStatus;
  visibility: VideoVisibility;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  playbackUrl: string | null;
  failureReason: string | null;
  channel: {
    name: string;
    handle: string;
  };
  publishedAt: string | null;
  createdAt: string;
}

export interface PublicVideoSummary {
  id: string;
  title: string;
  durationSeconds: number;
  thumbnailUrl: string;
  channel: {
    name: string;
    handle: string;
  };
  publishedAt: string;
}

export interface AuthenticatedUserResponse {
  id: string;
  email: string;
  username: string;
  channel: {
    id: string;
    name: string;
    handle: string;
  };
}

export interface UploadIntentResponse {
  uploadUrl: string;
  expiresInSeconds: number;
  requiredHeaders: Record<string, string>;
}

export interface CursorPage<T> {
  data: T[];
  page: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export const VIDEO_PROCESSING_QUEUE_NAME = 'video-processing';

export interface ProcessVideoJob {
  schemaVersion: 1;
  videoId: string;
  originalAssetId: string;
  correlationId: string;
}

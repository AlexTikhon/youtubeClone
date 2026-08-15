export const VIDEO_STATUSES = [
  'DRAFT',
  'UPLOADING',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

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
  channelId: string;
  title: string;
  description: string | null;
  status: VideoStatus;
  visibility: VideoVisibility;
  durationSeconds: number | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

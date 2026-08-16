export const VIDEO_STATUSES = [
  'DRAFT',
  'UPLOADING',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
  'DELETING',
] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

const ALLOWED_VIDEO_TRANSITIONS: Readonly<
  Record<VideoStatus, readonly VideoStatus[]>
> = {
  DRAFT: ['UPLOADING', 'DELETING'],
  UPLOADING: ['UPLOADED', 'FAILED', 'DELETING'],
  UPLOADED: ['PROCESSING', 'FAILED', 'DELETING'],
  PROCESSING: ['READY', 'FAILED', 'DELETING'],
  READY: ['DELETING'],
  FAILED: ['PROCESSING', 'DELETING'],
  DELETING: [],
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

export const PLAYLIST_VISIBILITIES = ['PRIVATE', 'PUBLIC'] as const;
export type PlaylistVisibility = (typeof PLAYLIST_VISIBILITIES)[number];
export const PLAYLIST_TYPES = ['STANDARD', 'WATCH_LATER'] as const;
export type PlaylistType = (typeof PLAYLIST_TYPES)[number];

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

export interface OwnerVideoDto {
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
  processingGeneration: number;
  processingStartedAt: string | null;
  processingFinishedAt: string | null;
  updatedAt: string;
  channel: {
    name: string;
    handle: string;
  };
  publishedAt: string | null;
  createdAt: string;
  viewsCount: number;
  likesCount: number;
  commentsCount: number;
}

export interface VideoCardDto {
  id: string;
  title: string;
  durationSeconds: number;
  thumbnailUrl: string | null;
  viewsCount: number;
  channel: {
    id: string;
    name: string;
    handle: string;
    avatarUrl: string | null;
  };
  publishedAt: string;
}

export interface PlaylistSummaryDto {
  id: string;
  title: string;
  description: string | null;
  visibility: PlaylistVisibility;
  type: PlaylistType;
  videoCount: number;
  coverThumbnailUrl: string | null;
  updatedAt: string;
  containsVideo: boolean;
}

export interface PlaylistDetailDto {
  id: string;
  title: string;
  description: string | null;
  visibility: PlaylistVisibility;
  type: PlaylistType;
  owner: { id: string; username: string };
  ownedByCurrentUser: boolean;
  videoCount: number;
  videos: Array<{ position: number; addedAt: string; video: VideoCardDto }>;
}

/** @deprecated Use the purpose-built owner/card DTOs. */
export type VideoSummary = OwnerVideoDto;
/** @deprecated Use VideoCardDto. */
export type PublicVideoSummary = VideoCardDto;

export interface WatchVideoDto {
  id: string;
  title: string;
  visibility: VideoVisibility;
  description: string | null;
  durationSeconds: number;
  playbackUrl: string;
  publishedAt: string | null;
  viewsCount: number;
  likesCount: number;
  commentsCount: number;
  likedByCurrentUser: boolean;
  channel: {
    id: string;
    handle: string;
    name: string;
    avatarUrl: string | null;
    subscribersCount: number;
    subscribedByCurrentUser: boolean;
  };
  resumePositionSeconds: number | null;
}

export interface CommentDto {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  canDelete: boolean;
  author: { id: string; username: string; avatarUrl: string | null };
}

export interface ChannelDto {
  id: string;
  handle: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  subscribersCount: number;
  subscribedByCurrentUser: boolean;
  ownedByCurrentUser: boolean;
}

export interface SubscriptionStateDto {
  subscribed: boolean;
  subscriberCount: number;
}

export interface LikeStateDto {
  liked: boolean;
  likesCount: number;
}

export interface HistoryItemDto {
  video: Omit<VideoCardDto, 'publishedAt'> & { publishedAt: string | null };
  lastPositionSeconds: number;
  lastWatchedAt: string;
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
  generation: number;
  correlationId: string;
}

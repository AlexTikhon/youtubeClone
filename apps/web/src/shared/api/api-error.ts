import type { ApiErrorEnvelope } from '@youtube-clone/types';

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export type ApiErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'unknown';

export interface ApiErrorPresentation {
  kind: ApiErrorKind;
  message: string;
}

export function getApiErrorPresentation(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): ApiErrorPresentation {
  if (!(error instanceof ApiClientError)) {
    return { kind: 'unknown', message: fallback };
  }
  if (error.status === 0) {
    return {
      kind: 'network',
      message: 'Check your connection and try again.',
    };
  }
  const byStatus: Partial<Record<number, ApiErrorPresentation>> = {
    401: {
      kind: 'unauthenticated',
      message: 'Log in to continue.',
    },
    403: {
      kind: 'forbidden',
      message: 'You do not have permission to do that.',
    },
    404: { kind: 'not-found', message: 'This resource is not available.' },
    409: {
      kind: 'conflict',
      message: 'The resource changed. Refresh and try again.',
    },
    429: {
      kind: 'rate-limited',
      message: 'Too many requests. Wait a moment and try again.',
    },
  };
  const presentation = byStatus[error.status];
  if (presentation) return presentation;
  if (error.status >= 500) {
    return {
      kind: 'server',
      message: 'The service is temporarily unavailable. Please try again.',
    };
  }
  return { kind: 'unknown', message: fallback };
}

export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (!value || typeof value !== 'object' || !('error' in value)) return false;
  const error = value.error;
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string' &&
    'requestId' in error &&
    typeof error.requestId === 'string'
  );
}

import { publicEnvironment } from '@/shared/config/public-environment';

import { ApiClientError, isApiErrorEnvelope } from './api-error';

interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  if (options.body !== undefined)
    headers.set('content-type', 'application/json');
  if (
    !headers.has('x-request-id') &&
    typeof crypto !== 'undefined' &&
    crypto.randomUUID
  ) {
    headers.set('x-request-id', crypto.randomUUID());
  }

  const response = await fetch(
    new URL(path, publicEnvironment.NEXT_PUBLIC_API_URL),
    {
      ...options,
      headers,
      credentials: 'include',
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    },
  );
  if (response.ok) return (await response.json()) as T;

  const payload: unknown = await response.json().catch(() => null);
  if (isApiErrorEnvelope(payload)) {
    throw new ApiClientError(
      payload.error.message,
      response.status,
      payload.error.code,
      payload.error.requestId,
      payload.error.details,
    );
  }
  throw new ApiClientError(
    'The API request failed',
    response.status,
    'UNKNOWN_API_ERROR',
  );
}

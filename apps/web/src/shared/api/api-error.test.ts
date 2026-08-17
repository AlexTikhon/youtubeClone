import { describe, expect, it } from 'vitest';
import { ApiClientError, getApiErrorPresentation } from './api-error';

describe('getApiErrorPresentation', () => {
  it.each([
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [409, 'conflict'],
    [429, 'rate-limited'],
    [503, 'server'],
    [0, 'network'],
  ] as const)('maps HTTP status %i to %s', (status, kind) => {
    const result = getApiErrorPresentation(
      new ApiClientError('internal detail', status, 'CODE'),
    );
    expect(result.kind).toBe(kind);
    expect(result.message).not.toContain('internal detail');
  });
});

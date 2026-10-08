import { describe, expect, it } from 'vitest';

import { ApiClientError } from '@/shared/api/api-error';

import {
  decideFromOwnerState,
  isUncertainApiFailure,
  recoveryForCompletionRejection,
} from './upload-recovery';

describe('upload recovery decisions', () => {
  it.each([
    [new ApiClientError('offline', 0, 'NETWORK_ERROR'), true],
    [new ApiClientError('bad gateway', 502, 'HTTP_502'), true],
    [new ApiClientError('unavailable', 503, 'STORAGE_UNAVAILABLE'), true],
    [new ApiClientError('timeout', 408, 'HTTP_408'), true],
    [new ApiClientError('conflict', 409, 'UPLOADED_OBJECT_NOT_FOUND'), false],
    [new ApiClientError('login', 401, 'UNAUTHENTICATED'), false],
    [new Error('anything else'), false],
  ])('classifies %s as uncertain=%s', (error, uncertain) => {
    expect(isUncertainApiFailure(error)).toBe(uncertain);
  });

  it.each([
    'UPLOADED_OBJECT_NOT_FOUND',
    'UPLOADED_OBJECT_EMPTY',
    'UPLOAD_SIZE_MISMATCH',
    'UPLOAD_CONTENT_TYPE_MISMATCH',
  ])('requires a new upload when completion is rejected with %s', (code) => {
    expect(
      recoveryForCompletionRejection(new ApiClientError('no', 409, code)),
    ).toBe('upload-failed');
  });

  it('only retries finalization for any other completion rejection', () => {
    expect(
      recoveryForCompletionRejection(
        new ApiClientError('x', 503, 'STORAGE_UNAVAILABLE'),
      ),
    ).toBe('completion-uncertain');
    expect(recoveryForCompletionRejection(new Error('boom'))).toBe(
      'completion-uncertain',
    );
  });

  it.each([
    ['UPLOADED', 1, 'accepted'],
    ['PROCESSING', 1, 'accepted'],
    ['READY', 1, 'accepted'],
    ['FAILED', 2, 'accepted'],
    ['UPLOADING', 0, 'finalize'],
    ['DRAFT', 0, 'reupload'],
    ['FAILED', 0, 'reupload'],
    ['DELETING', 1, 'reupload'],
  ] as const)(
    'maps owner state %s (generation %s) to %s',
    (status, processingGeneration, decision) => {
      expect(decideFromOwnerState({ status, processingGeneration })).toBe(
        decision,
      );
    },
  );
});

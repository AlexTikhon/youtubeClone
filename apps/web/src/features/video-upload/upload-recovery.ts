import type { OwnerVideoDto } from '@youtube-clone/types';

import { ApiClientError } from '@/shared/api/api-error';

/**
 * - upload-failed: the stored bytes are missing or unusable; upload again.
 * - completion-uncertain: the bytes are stored; only finalization needs retrying.
 * Processing failure is a third, separate state read from the video itself.
 */
export type RecoveryKind = 'upload-failed' | 'completion-uncertain';

/** A response that may never have been seen although the server acted on it. */
export function isUncertainApiFailure(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    (error.status === 0 || error.status === 408 || error.status >= 500)
  );
}

const REUPLOAD_CODES = new Set([
  'UPLOADED_OBJECT_NOT_FOUND',
  'UPLOADED_OBJECT_EMPTY',
  'UPLOAD_SIZE_MISMATCH',
  'UPLOAD_CONTENT_TYPE_MISMATCH',
]);

export function recoveryForCompletionRejection(error: unknown): RecoveryKind {
  return error instanceof ApiClientError && REUPLOAD_CODES.has(error.code)
    ? 'upload-failed'
    : 'completion-uncertain';
}

export type OwnerStateDecision = 'accepted' | 'finalize' | 'reupload';

/**
 * What an uncertain completion actually did, judged from the owner's view of
 * the video: accepted (keep observing processing), still awaiting finalization
 * (retry only finalization), or never reached storage (upload again).
 */
export function decideFromOwnerState(
  video: Pick<OwnerVideoDto, 'status' | 'processingGeneration'>,
): OwnerStateDecision {
  switch (video.status) {
    case 'UPLOADED':
    case 'PROCESSING':
    case 'READY':
      return 'accepted';
    case 'FAILED':
      return video.processingGeneration >= 1 ? 'accepted' : 'reupload';
    case 'UPLOADING':
      return 'finalize';
    default:
      return 'reupload';
  }
}

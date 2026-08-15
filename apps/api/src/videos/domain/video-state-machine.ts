import type { VideoStatus } from '@youtube-clone/types';

const allowedTransitions: Readonly<
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
  if (!allowedTransitions[from].includes(to))
    throw new InvalidVideoTransitionError(from, to);
}

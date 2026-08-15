import { describe, expect, it } from 'vitest';

import {
  assertVideoTransition,
  InvalidVideoTransitionError,
} from './video-state-machine.js';

describe('video processing state machine', () => {
  it.each([
    ['DRAFT', 'UPLOADING'],
    ['UPLOADING', 'UPLOADED'],
    ['UPLOADED', 'PROCESSING'],
    ['PROCESSING', 'READY'],
    ['PROCESSING', 'FAILED'],
    ['FAILED', 'PROCESSING'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(() => assertVideoTransition(from, to)).not.toThrow();
  });

  it('does not allow publishing a draft by skipping processing', () => {
    expect(() => assertVideoTransition('DRAFT', 'READY')).toThrow(
      InvalidVideoTransitionError,
    );
  });
});

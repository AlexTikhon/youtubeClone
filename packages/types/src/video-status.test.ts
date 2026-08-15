import { describe, expect, it } from 'vitest';

import { VIDEO_STATUSES } from './index.js';

describe('video status contract', () => {
  it('keeps the processing lifecycle explicit and ordered', () => {
    expect(VIDEO_STATUSES).toEqual([
      'DRAFT',
      'UPLOADING',
      'UPLOADED',
      'PROCESSING',
      'READY',
      'FAILED',
    ]);
  });
});

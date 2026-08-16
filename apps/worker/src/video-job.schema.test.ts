import { describe, expect, it } from 'vitest';

import { processVideoJobSchema } from './video-job.schema.js';

describe('processVideoJobSchema', () => {
  it('rejects jobs from an unknown contract version', () => {
    const result = processVideoJobSchema.safeParse({
      schemaVersion: 2,
      videoId: 'f597a64a-6c1f-4a12-88b9-1e35467bced8',
      originalAssetId: 'b1ac9537-d7bf-48ff-9989-e7767caa7f12',
      generation: 1,
      correlationId: 'request-1',
    });
    expect(result.success).toBe(false);
  });
});

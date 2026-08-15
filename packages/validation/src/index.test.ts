import { describe, expect, it } from 'vitest';

import { createVideoSchema } from './index.js';

describe('createVideoSchema', () => {
  it('normalizes a valid draft and defaults it to private', () => {
    expect(
      createVideoSchema.parse({
        channelId: 'f597a64a-6c1f-4a12-88b9-1e35467bced8',
        title: '  Architecture tour  ',
      }),
    ).toEqual({
      channelId: 'f597a64a-6c1f-4a12-88b9-1e35467bced8',
      title: 'Architecture tour',
      visibility: 'PRIVATE',
    });
  });
});

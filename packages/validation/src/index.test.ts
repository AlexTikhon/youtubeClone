import { describe, expect, it } from 'vitest';

import { createVideoSchema } from './index.js';

describe('createVideoSchema', () => {
  it('normalizes a valid draft and defaults it to private', () => {
    expect(
      createVideoSchema.parse({
        title: '  Architecture tour  ',
      }),
    ).toEqual({
      title: 'Architecture tour',
      visibility: 'PRIVATE',
    });
  });
});

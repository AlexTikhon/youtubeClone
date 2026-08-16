import { describe, expect, it } from 'vitest';

import { startUploadSchema } from './upload.schemas.js';

describe('startUploadSchema', () => {
  it('accepts a non-empty MP4 within the configured product limit', () => {
    expect(
      startUploadSchema.parse({
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      }),
    ).toMatchObject({ contentType: 'video/mp4', sizeBytes: 1024 });
  });

  it('rejects unapproved browser content types', () => {
    expect(() =>
      startUploadSchema.parse({
        fileName: 'clip.webm',
        contentType: 'video/webm',
        sizeBytes: 1024,
      }),
    ).toThrow();
  });
});

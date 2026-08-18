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

  it('validates numeric safety without imposing the deployment upload limit', () => {
    expect(
      startUploadSchema.parse({
        fileName: 'large.mp4',
        contentType: 'video/mp4',
        sizeBytes: 3 * 1024 * 1024 * 1024,
      }).sizeBytes,
    ).toBe(3 * 1024 * 1024 * 1024);
    expect(() =>
      startUploadSchema.parse({
        fileName: 'unsafe.mp4',
        contentType: 'video/mp4',
        sizeBytes: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });
});

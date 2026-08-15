import { describe, expect, it } from 'vitest';

import { validateVideoFile } from './video-upload-form';

describe('video upload validation', () => {
  it('accepts a non-empty MP4', () => {
    const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
    expect(validateVideoFile(file)).toBeNull();
  });

  it('rejects empty and unsupported files', () => {
    expect(
      validateVideoFile(new File([], 'empty.mp4', { type: 'video/mp4' })),
    ).toContain('non-empty');
    expect(
      validateVideoFile(
        new File(['video'], 'clip.webm', { type: 'video/webm' }),
      ),
    ).toContain('MP4');
  });
});

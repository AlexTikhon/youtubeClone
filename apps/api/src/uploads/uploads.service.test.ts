import { describe, expect, it, vi } from 'vitest';

import { UploadsService } from './uploads.service.js';

describe('UploadsService completion boundary', () => {
  it('rejects stored content that does not match the upload intent', async () => {
    const videos = {
      findOwned: vi.fn().mockResolvedValue({
        id: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
        status: 'UPLOADING',
        upload: {
          id: '0ab359e2-d72a-44b3-a797-70f5f00936e4',
          bucket: 'video-originals',
          objectKey: 'originals/video/file.mp4',
          contentType: 'video/mp4',
          expectedSizeBytes: 100n,
        },
      }),
    };
    const storage = {
      headObject: vi.fn().mockResolvedValue({
        contentType: 'text/plain',
        sizeBytes: 100n,
      }),
    };
    const service = new UploadsService(
      {} as never,
      videos as never,
      storage as never,
      { enqueue: vi.fn() } as never,
      {} as never,
    );
    await expect(
      service.complete(
        'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
        'owner-id',
        'request-id',
      ),
    ).rejects.toMatchObject({
      code: 'UPLOAD_CONTENT_TYPE_MISMATCH',
      status: 409,
    });
  });
});

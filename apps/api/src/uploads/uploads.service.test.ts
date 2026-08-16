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

  it('writes generation one and its outbox event in the completion transaction', async () => {
    const video = {
      id: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
      status: 'UPLOADING',
      processingGeneration: 0,
      upload: {
        id: '0ab359e2-d72a-44b3-a797-70f5f00936e4',
        bucket: 'video-originals',
        objectKey: 'originals/video/file.mp4',
        contentType: 'video/mp4',
        expectedSizeBytes: 100n,
      },
    };
    const transaction = {
      video: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      videoUpload: { update: vi.fn().mockResolvedValue({}) },
      videoAsset: {
        upsert: vi.fn().mockResolvedValue({ id: 'original-asset-id' }),
      },
      processingOutbox: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (input: typeof transaction) => Promise<void>) =>
          callback(transaction),
      ),
    };
    const service = new UploadsService(
      prisma as never,
      { findOwned: vi.fn().mockResolvedValue(video) } as never,
      {
        headObject: vi.fn().mockResolvedValue({
          contentType: 'video/mp4',
          sizeBytes: 100n,
        }),
      } as never,
      {} as never,
    );

    await service.complete(video.id, 'owner-id', 'request-id');

    expect(transaction.video.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ processingGeneration: 1 }),
      }),
    );
    expect(transaction.processingOutbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          generation: 1,
          originalAssetId: 'original-asset-id',
        }),
      }),
    );
  });
});

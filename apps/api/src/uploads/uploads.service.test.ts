import { describe, expect, it, vi } from 'vitest';

import {
  ObjectNotFoundError,
  ObjectStorageUnavailableError,
} from '../infrastructure/storage/storage.port.js';
import { UploadsService } from './uploads.service.js';

describe('UploadsService configured limit', () => {
  it('enforces an environment-specific lower upload limit', async () => {
    const service = new UploadsService(
      {} as never,
      { findOwned: vi.fn() } as never,
      {} as never,
      { MAX_UPLOAD_SIZE_BYTES: 100 } as never,
    );

    await expect(
      service.start('video-id', 'owner-id', {
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 101,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
  });
});

describe('UploadsService completion boundary', () => {
  function createCompletionService(storageError: Error) {
    return new UploadsService(
      {} as never,
      {
        findOwned: vi.fn().mockResolvedValue({
          id: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
          status: 'UPLOADING',
          upload: {
            bucket: 'video-originals',
            objectKey: 'originals/video/file.mp4',
          },
        }),
      } as never,
      { headObject: vi.fn().mockRejectedValue(storageError) } as never,
      {} as never,
    );
  }

  it('keeps the existing conflict for a genuinely missing upload', async () => {
    const service = createCompletionService(new ObjectNotFoundError());
    await expect(
      service.complete('video-id', 'owner-id', 'request-id'),
    ).rejects.toMatchObject({
      code: 'UPLOADED_OBJECT_NOT_FOUND',
      status: 409,
    });
  });

  it('reports storage downtime without instructing the user to re-upload', async () => {
    const service = createCompletionService(
      new ObjectStorageUnavailableError(),
    );
    await expect(
      service.complete('video-id', 'owner-id', 'request-id'),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
  });

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

describe('UploadsService upload admission', () => {
  const upload = {
    id: '0ab359e2-d72a-44b3-a797-70f5f00936e4',
    bucket: 'video-originals',
    objectKey: 'originals/video/file.mp4',
    contentType: 'video/mp4',
    expectedSizeBytes: 1_000n,
    status: 'PENDING',
  };
  const policy = {
    url: 'http://storage.test/video-originals',
    fields: { key: upload.objectKey, 'Content-Type': 'video/mp4' },
  };

  function createStartService(storage: object, maxBytes = 2_000) {
    const transaction = {
      video: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      videoUpload: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (input: typeof transaction) => Promise<void>) =>
          callback(transaction),
      ),
    };
    return {
      transaction,
      service: new UploadsService(
        prisma as never,
        {
          findOwned: vi.fn().mockResolvedValue({
            id: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
            status: 'DRAFT',
            upload: null,
          }),
        } as never,
        storage as never,
        {
          MAX_UPLOAD_SIZE_BYTES: maxBytes,
          S3_BUCKET_ORIGINALS: 'video-originals',
        } as never,
      ),
    };
  }

  it('returns a storage-enforced policy bound to the declared size', async () => {
    const storage = { createUploadPolicy: vi.fn().mockResolvedValue(policy) };
    const { service, transaction } = createStartService(storage);

    const response = await service.start('video-id', 'owner-id', {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1_000,
    });

    expect(storage.createUploadPolicy).toHaveBeenCalledWith({
      bucket: 'video-originals',
      objectKey: expect.stringMatching(/^originals\/.+\.mp4$/),
      contentType: 'video/mp4',
      sizeBytes: 1_000n,
      expiresInSeconds: 900,
    });
    expect(response).toEqual({
      method: 'POST',
      uploadUrl: policy.url,
      fields: policy.fields,
      sizeBytes: 1_000,
      expiresInSeconds: 900,
    });
    expect(transaction.videoUpload.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ expectedSizeBytes: 1_000n }),
    });
  });

  it('re-signs a pending intent with the originally declared size', async () => {
    const storage = { createUploadPolicy: vi.fn().mockResolvedValue(policy) };
    const service = new UploadsService(
      {} as never,
      {
        findOwned: vi.fn().mockResolvedValue({
          id: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
          status: 'UPLOADING',
          upload,
        }),
      } as never,
      storage as never,
      { MAX_UPLOAD_SIZE_BYTES: 2_000 } as never,
    );

    await service.start('video-id', 'owner-id', {
      fileName: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1_000,
    });

    expect(storage.createUploadPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: upload.objectKey,
        sizeBytes: 1_000n,
      }),
    );
  });

  it('refuses to re-sign a pending intent after the limit was lowered', async () => {
    const storage = { createUploadPolicy: vi.fn() };
    const service = new UploadsService(
      {} as never,
      {
        findOwned: vi.fn().mockResolvedValue({
          id: 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0',
          status: 'UPLOADING',
          upload,
        }),
      } as never,
      storage as never,
      { MAX_UPLOAD_SIZE_BYTES: 999 } as never,
    );

    await expect(
      service.start('video-id', 'owner-id', {
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
    expect(storage.createUploadPolicy).not.toHaveBeenCalled();
  });

  it('reports a signing outage as retryable storage unavailability', async () => {
    const storage = {
      createUploadPolicy: vi
        .fn()
        .mockRejectedValue(new ObjectStorageUnavailableError()),
    };
    const { service } = createStartService(storage);

    await expect(
      service.start('video-id', 'owner-id', {
        fileName: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
  });
});

describe('UploadsService idempotent completion', () => {
  const videoId = 'ad358d90-fbd5-4ef5-b567-c620b3f0fca0';
  const upload = {
    id: '0ab359e2-d72a-44b3-a797-70f5f00936e4',
    bucket: 'video-originals',
    objectKey: 'originals/video/file.mp4',
    contentType: 'video/mp4',
    expectedSizeBytes: 100n,
    status: 'COMPLETED',
  };
  const accepted = (status: string, generation = 1) => ({
    id: videoId,
    status,
    processingGeneration: generation,
    upload,
  });

  function createService(
    reads: unknown[],
    options: { transaction?: object; head?: unknown } = {},
  ) {
    const findOwned = vi.fn();
    for (const read of reads) findOwned.mockResolvedValueOnce(read);
    const storage = {
      headObject: vi
        .fn()
        .mockResolvedValue(
          options.head ?? { contentType: 'video/mp4', sizeBytes: 100n },
        ),
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (input: object) => unknown) =>
        callback(options.transaction ?? {}),
      ),
    };
    return {
      storage,
      prisma,
      findOwned,
      service: new UploadsService(
        prisma as never,
        { findOwned } as never,
        storage as never,
        {} as never,
      ),
    };
  }

  it.each(['UPLOADED', 'PROCESSING', 'READY', 'FAILED'] as const)(
    'returns the accepted %s state when the same completed upload is replayed',
    async (status) => {
      const { service, storage, prisma } = createService([accepted(status, 3)]);

      await expect(
        service.complete(videoId, 'owner-id', 'request-id'),
      ).resolves.toEqual({
        videoId,
        status,
        processingGeneration: 3,
        alreadyCompleted: true,
      });

      expect(storage.headObject).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a video being deleted', { ...accepted('DELETING') }],
    [
      'a failed video whose upload never completed',
      {
        ...accepted('FAILED'),
        upload: { ...upload, status: 'PENDING' },
      },
    ],
    ['a draft without an upload', { ...accepted('DRAFT'), upload: null }],
    [
      'a ready video without a completed upload',
      {
        ...accepted('READY'),
        upload: { ...upload, status: 'PENDING' },
      },
    ],
  ])('still rejects %s', async (_name, video) => {
    const { service, storage } = createService([video]);

    await expect(
      service.complete(videoId, 'owner-id', 'request-id'),
    ).rejects.toMatchObject({ status: 409 });
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it('turns a lost completion race into the winner’s accepted state', async () => {
    const transaction = {
      video: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      videoUpload: { update: vi.fn() },
      videoAsset: { upsert: vi.fn() },
      processingOutbox: { upsert: vi.fn() },
    };
    const { service } = createService(
      [
        { ...accepted('UPLOADING'), upload: { ...upload, status: 'PENDING' } },
        accepted('PROCESSING'),
      ],
      { transaction },
    );

    await expect(
      service.complete(videoId, 'owner-id', 'request-id'),
    ).resolves.toEqual({
      videoId,
      status: 'PROCESSING',
      processingGeneration: 1,
      alreadyCompleted: true,
    });
    expect(transaction.videoAsset.upsert).not.toHaveBeenCalled();
    expect(transaction.processingOutbox.upsert).not.toHaveBeenCalled();
  });

  it('keeps the state conflict when the lost race was not a completion', async () => {
    const transaction = {
      video: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };
    const { service } = createService(
      [
        { ...accepted('UPLOADING'), upload: { ...upload, status: 'PENDING' } },
        accepted('DELETING'),
      ],
      { transaction },
    );

    await expect(
      service.complete(videoId, 'owner-id', 'request-id'),
    ).rejects.toMatchObject({ code: 'VIDEO_STATE_CONFLICT', status: 409 });
  });

  it('reports a first completion as not previously completed', async () => {
    const transaction = {
      video: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      videoUpload: { update: vi.fn().mockResolvedValue({}) },
      videoAsset: { upsert: vi.fn().mockResolvedValue({ id: 'asset-id' }) },
      processingOutbox: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const { service } = createService(
      [
        {
          ...accepted('UPLOADING', 0),
          upload: { ...upload, status: 'PENDING' },
        },
      ],
      { transaction },
    );

    await expect(
      service.complete(videoId, 'owner-id', 'request-id'),
    ).resolves.toEqual({
      videoId,
      status: 'UPLOADED',
      processingGeneration: 1,
      alreadyCompleted: false,
    });
  });
});

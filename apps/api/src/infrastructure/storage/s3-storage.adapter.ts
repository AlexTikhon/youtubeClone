import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';

import type { ApiEnvironment } from '@youtube-clone/config';

import { API_ENVIRONMENT } from '../../config/config.module.js';
import type {
  CreateUploadUrlInput,
  ObjectStorage,
  StoredObject,
  StoredObjectMetadata,
} from './storage.port.js';

@Injectable()
export class S3StorageAdapter implements ObjectStorage {
  private readonly client: S3Client;

  constructor(
    @Inject(API_ENVIRONMENT) private readonly environment: ApiEnvironment,
  ) {
    this.client = new S3Client({
      endpoint: environment.S3_ENDPOINT,
      region: environment.S3_REGION,
      forcePathStyle: environment.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: environment.S3_ACCESS_KEY,
        secretAccessKey: environment.S3_SECRET_KEY,
      },
    });
  }

  createUploadUrl(input: CreateUploadUrlInput): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.objectKey,
        ContentType: input.contentType,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async headObject(
    bucket: string,
    objectKey: string,
  ): Promise<StoredObjectMetadata> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
    );
    return {
      contentType: result.ContentType ?? 'application/octet-stream',
      sizeBytes:
        result.ContentLength === undefined
          ? null
          : BigInt(result.ContentLength),
    };
  }

  async getObject(bucket: string, objectKey: string): Promise<StoredObject> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    );
    if (!result.Body || !('pipe' in result.Body))
      throw new Error('Object response is not a Node.js stream');
    return {
      body: result.Body as NodeJS.ReadableStream,
      contentType: result.ContentType ?? 'application/octet-stream',
      sizeBytes: result.ContentLength ?? null,
    };
  }
}

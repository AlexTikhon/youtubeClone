import {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';

import type { ApiEnvironment } from '@youtube-clone/config';

import { API_ENVIRONMENT } from '../../config/config.module.js';
import type {
  CreateUploadUrlInput,
  ObjectStorage,
  StoredObject,
  StoredObjectMetadata,
} from './storage.port.js';
import {
  ObjectNotFoundError,
  ObjectStorageUnavailableError,
} from './storage.port.js';

@Injectable()
export class S3StorageAdapter implements ObjectStorage, OnApplicationShutdown {
  private readonly logger = new Logger(S3StorageAdapter.name);
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

  async createUploadUrl(input: CreateUploadUrlInput): Promise<string> {
    try {
      return await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.objectKey,
          ContentType: input.contentType,
        }),
        { expiresIn: input.expiresInSeconds },
      );
    } catch (error) {
      throwStorageError(error);
    }
  }

  async headObject(
    bucket: string,
    objectKey: string,
  ): Promise<StoredObjectMetadata> {
    try {
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
    } catch (error) {
      throwStorageError(error);
    }
  }

  async getObject(bucket: string, objectKey: string): Promise<StoredObject> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
      if (!result.Body || !('pipe' in result.Body))
        throw new Error('Object response is not a Node.js stream');
      return {
        body: result.Body as Readable,
        contentType: result.ContentType ?? 'application/octet-stream',
        sizeBytes: result.ContentLength ?? null,
      };
    } catch (error) {
      throwStorageError(error);
    }
  }

  async deleteObject(bucket: string, objectKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
    } catch (error) {
      throwStorageError(error);
    }
  }

  async deletePrefix(bucket: string, prefix: string): Promise<void> {
    try {
      let continuationToken: string | undefined;
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        const objects =
          page.Contents?.flatMap((item) =>
            item.Key ? [{ Key: item.Key }] : [],
          ) ?? [];
        if (objects.length) {
          const result = await this.client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects, Quiet: true },
            }),
          );
          if (result.Errors?.length) {
            this.logger.error({
              event: 'storage.delete_prefix.partial_failure',
              failureCount: result.Errors.length,
              errorCodes: [
                ...new Set(
                  result.Errors.flatMap((error) =>
                    error.Code ? [error.Code] : [],
                  ),
                ),
              ],
            });
            throw new ObjectStorageUnavailableError();
          }
        }
        continuationToken = page.NextContinuationToken;
      } while (continuationToken);
    } catch (error) {
      throwStorageError(error);
    }
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

function throwStorageError(error: unknown): never {
  if (
    error instanceof ObjectNotFoundError ||
    error instanceof ObjectStorageUnavailableError
  ) {
    throw error;
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    typeof error.name === 'string' &&
    ['NotFound', 'NoSuchKey', 'NoSuchObject'].includes(error.name)
  ) {
    throw new ObjectNotFoundError({ cause: error });
  }
  throw new ObjectStorageUnavailableError({ cause: error });
}

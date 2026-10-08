import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';

import { workerEnvironment } from './config.js';
import { ProcessingError } from './processing-error.js';

/**
 * Every processing attempt writes under its own prefix. Overlapping attempts in
 * one generation therefore never share keys, and cleanup of a losing attempt
 * cannot reach published media.
 */
export function attemptPrefix(
  videoId: string,
  generation: number,
  attemptId: string,
): string {
  return `videos/${videoId}/generations/${generation}/attempts/${attemptId}/`;
}

@Injectable()
export class StorageService implements OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);
  private readonly client = new S3Client({
    endpoint: workerEnvironment.S3_ENDPOINT,
    region: workerEnvironment.S3_REGION,
    forcePathStyle: workerEnvironment.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: workerEnvironment.S3_ACCESS_KEY,
      secretAccessKey: workerEnvironment.S3_SECRET_KEY,
    },
  });

  async download(
    bucket: string,
    objectKey: string,
    destination: string,
    expectedSizeBytes: bigint | null,
    signal?: AbortSignal,
  ): Promise<void> {
    let body: Readable | undefined;
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
        { abortSignal: signal },
      );
      if (result.Body instanceof Readable) body = result.Body;
      if (
        expectedSizeBytes !== null &&
        (result.ContentLength === undefined ||
          BigInt(result.ContentLength) !== expectedSizeBytes)
      ) {
        if (result.Body instanceof Readable) result.Body.destroy();
        throw new ProcessingError(
          'Original object size changed after upload completion',
          false,
          'The uploaded video changed before processing',
        );
      }
      if (!(result.Body instanceof Readable))
        throw new Error('Storage did not return a Node.js stream');
      await pipeline(result.Body, createWriteStream(destination), { signal });
    } catch (error) {
      // Cancellation outranks whatever the interrupted transfer reported.
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ProcessingError) throw error;
      throw new ProcessingError(
        `Could not download original ${bucket}/${objectKey}`,
        true,
        'The original video could not be read from storage',
        { cause: error },
      );
    } finally {
      body?.destroy();
    }
  }

  async checkReady(): Promise<void> {
    await Promise.all(
      [
        workerEnvironment.S3_BUCKET_ORIGINALS,
        workerEnvironment.S3_BUCKET_STREAMS,
        workerEnvironment.S3_BUCKET_THUMBNAILS,
      ].map((bucket) =>
        this.client.send(new HeadBucketCommand({ Bucket: bucket })),
      ),
    );
  }

  async uploadThumbnail(
    videoId: string,
    generation: number,
    attemptId: string,
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<{ bucket: string; objectKey: string; sizeBytes: bigint }> {
    const bucket = workerEnvironment.S3_BUCKET_THUMBNAILS;
    const objectKey = `${attemptPrefix(videoId, generation, attemptId)}thumbnail/thumbnail.jpg`;
    const sizeBytes = await this.uploadFile(
      bucket,
      objectKey,
      sourcePath,
      'image/jpeg',
      signal,
    );
    return { bucket, objectKey, sizeBytes };
  }

  async uploadHls(
    videoId: string,
    generation: number,
    attemptId: string,
    sourceDirectory: string,
    renditionNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<{
    bucket: string;
    masterManifestKey: string;
    masterManifestSizeBytes: bigint;
    storagePrefix: string;
    renditions: Array<{
      name: string;
      storagePrefix: string;
      manifestKey: string;
      segmentCount: number;
    }>;
  }> {
    const bucket = workerEnvironment.S3_BUCKET_STREAMS;
    const storagePrefix = `${attemptPrefix(videoId, generation, attemptId)}hls/`;
    const rootFiles = await readdir(sourceDirectory);
    if (
      !rootFiles.includes('master.m3u8') ||
      renditionNames.length === 0 ||
      new Set(renditionNames).size !== renditionNames.length ||
      renditionNames.some((name) => !/^(source|360p|480p|720p)$/.test(name))
    ) {
      throw new ProcessingError(
        'The generated HLS rendition list is invalid',
        false,
        'The video could not be packaged for playback',
      );
    }
    try {
      const renditions = [];
      for (const name of renditionNames) {
        const renditionDirectory = join(sourceDirectory, name);
        const fileNames = await readdir(renditionDirectory);
        const segments = fileNames
          .filter((fileName) => /^segment\d{3,6}\.ts$/.test(fileName))
          .sort();
        if (!fileNames.includes('index.m3u8') || segments.length === 0) {
          throw new ProcessingError(
            `FFmpeg did not produce a complete ${name} HLS rendition`,
            false,
            'The video could not be packaged for playback',
          );
        }
        const renditionPrefix = `${storagePrefix}${name}/`;
        for (const fileName of segments) {
          await this.uploadFile(
            bucket,
            `${renditionPrefix}${fileName}`,
            join(renditionDirectory, fileName),
            'video/mp2t',
            signal,
          );
        }
        const manifestKey = `${renditionPrefix}index.m3u8`;
        await this.uploadFile(
          bucket,
          manifestKey,
          join(renditionDirectory, 'index.m3u8'),
          'application/vnd.apple.mpegurl',
          signal,
        );
        renditions.push({
          name,
          storagePrefix: renditionPrefix,
          manifestKey,
          segmentCount: segments.length,
        });
      }
      const masterManifestKey = `${storagePrefix}master.m3u8`;
      const masterManifestSizeBytes = await this.uploadFile(
        bucket,
        masterManifestKey,
        join(sourceDirectory, 'master.m3u8'),
        'application/vnd.apple.mpegurl',
        signal,
      );
      return {
        bucket,
        masterManifestKey,
        masterManifestSizeBytes,
        storagePrefix,
        renditions,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ProcessingError) throw error;
      throw new ProcessingError(
        'Could not upload generated HLS assets',
        true,
        'Generated playback assets could not be stored',
        { cause: error },
      );
    }
  }

  /** Removes one attempt's objects. Never touches any other attempt's prefix. */
  async removeAttempt(
    videoId: string,
    generation: number,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const prefix = attemptPrefix(videoId, generation, attemptId);
    await Promise.all([
      this.deletePrefix(
        workerEnvironment.S3_BUCKET_STREAMS,
        prefix,
        undefined,
        signal,
      ),
      this.deletePrefix(
        workerEnvironment.S3_BUCKET_THUMBNAILS,
        prefix,
        undefined,
        signal,
      ),
    ]);
  }

  /**
   * After an attempt commits, removes every other generated object for the
   * video: legacy layouts, earlier generations, and losing attempts.
   */
  async removeObsoleteGenerated(
    videoId: string,
    committedGeneration: number,
    committedAttemptId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const keep = attemptPrefix(
      videoId,
      committedGeneration,
      committedAttemptId,
    );
    await Promise.all([
      this.deletePrefix(
        workerEnvironment.S3_BUCKET_STREAMS,
        `videos/${videoId}/`,
        keep,
        signal,
      ),
      this.deletePrefix(
        workerEnvironment.S3_BUCKET_THUMBNAILS,
        `videos/${videoId}/`,
        keep,
        signal,
      ),
    ]);
  }

  private async uploadFile(
    bucket: string,
    objectKey: string,
    sourcePath: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<bigint> {
    signal?.throwIfAborted();
    const file = await stat(sourcePath);
    const body = createReadStream(sourcePath);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: body,
          ContentLength: file.size,
          ContentType: contentType,
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    } finally {
      // The SDK does not own the stream: release the file handle even when the
      // request was cancelled mid-transfer.
      body.destroy();
    }
    return BigInt(file.size);
  }

  private async deletePrefix(
    bucket: string,
    prefix: string,
    keepPrefix?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.deletePrefixPages(bucket, prefix, keepPrefix, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    }
  }

  private async deletePrefixPages(
    bucket: string,
    prefix: string,
    keepPrefix?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let continuationToken: string | undefined;
    do {
      signal?.throwIfAborted();
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
        { abortSignal: signal },
      );
      const objects =
        page.Contents?.flatMap((object) =>
          object.Key && !(keepPrefix && object.Key.startsWith(keepPrefix))
            ? [{ Key: object.Key }]
            : [],
        ) ?? [];
      if (objects.length > 0) {
        const result = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
          { abortSignal: signal },
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
          throw new ProcessingError(
            'Storage did not delete every generated object',
            true,
            'Generated media cleanup is temporarily incomplete',
          );
        }
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

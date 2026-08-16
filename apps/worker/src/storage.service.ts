import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';

import { workerEnvironment } from './config.js';
import { ProcessingError } from './processing-error.js';

@Injectable()
export class StorageService implements OnApplicationShutdown {
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
  ): Promise<void> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
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
      await pipeline(result.Body, createWriteStream(destination));
    } catch (error) {
      if (error instanceof ProcessingError) throw error;
      throw new ProcessingError(
        `Could not download original ${bucket}/${objectKey}`,
        true,
        'The original video could not be read from storage',
        { cause: error },
      );
    }
  }

  async uploadThumbnail(
    videoId: string,
    sourcePath: string,
  ): Promise<{ bucket: string; objectKey: string; sizeBytes: bigint }> {
    const bucket = workerEnvironment.S3_BUCKET_THUMBNAILS;
    const objectKey = `videos/${videoId}/thumbnail/thumbnail.jpg`;
    const sizeBytes = await this.uploadFile(
      bucket,
      objectKey,
      sourcePath,
      'image/jpeg',
    );
    return { bucket, objectKey, sizeBytes };
  }

  async uploadHls(
    videoId: string,
    sourceDirectory: string,
    renditionNames: readonly string[],
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
    const storagePrefix = `videos/${videoId}/hls/`;
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
          );
        }
        const manifestKey = `${renditionPrefix}index.m3u8`;
        await this.uploadFile(
          bucket,
          manifestKey,
          join(renditionDirectory, 'index.m3u8'),
          'application/vnd.apple.mpegurl',
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
      );
      return {
        bucket,
        masterManifestKey,
        masterManifestSizeBytes,
        storagePrefix,
        renditions,
      };
    } catch (error) {
      if (error instanceof ProcessingError) throw error;
      throw new ProcessingError(
        'Could not upload generated HLS assets',
        true,
        'Generated playback assets could not be stored',
        { cause: error },
      );
    }
  }

  async removeGenerated(videoId: string): Promise<void> {
    await Promise.all([
      this.deletePrefix(
        workerEnvironment.S3_BUCKET_STREAMS,
        `videos/${videoId}/hls/`,
      ),
      this.deletePrefix(
        workerEnvironment.S3_BUCKET_THUMBNAILS,
        `videos/${videoId}/thumbnail/`,
      ),
    ]);
  }

  private async uploadFile(
    bucket: string,
    objectKey: string,
    sourcePath: string,
    contentType: string,
  ): Promise<bigint> {
    const file = await stat(sourcePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: createReadStream(sourcePath),
        ContentLength: file.size,
        ContentType: contentType,
      }),
    );
    return BigInt(file.size);
  }

  private async deletePrefix(bucket: string, prefix: string): Promise<void> {
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
        page.Contents?.flatMap((object) =>
          object.Key ? [{ Key: object.Key }] : [],
        ) ?? [];
      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

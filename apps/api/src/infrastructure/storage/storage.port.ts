import type { Readable } from 'node:stream';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface CreateUploadUrlInput {
  bucket: string;
  objectKey: string;
  contentType: string;
  expiresInSeconds: number;
}

export interface StoredObjectMetadata {
  contentType: string;
  sizeBytes: bigint | null;
}

export interface StoredObject {
  body: Readable;
  contentType: string;
  sizeBytes: number | null;
}

export interface ObjectStorage {
  createUploadUrl(input: CreateUploadUrlInput): Promise<string>;
  headObject(bucket: string, objectKey: string): Promise<StoredObjectMetadata>;
  getObject(bucket: string, objectKey: string): Promise<StoredObject>;
  deleteObject(bucket: string, objectKey: string): Promise<void>;
  deletePrefix(bucket: string, prefix: string): Promise<void>;
}

export class ObjectNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super('The requested storage object was not found', options);
    this.name = 'ObjectNotFoundError';
  }
}

export class ObjectStorageUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('Object storage is unavailable', options);
    this.name = 'ObjectStorageUnavailableError';
  }
}

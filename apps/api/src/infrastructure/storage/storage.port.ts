import type { Readable } from 'node:stream';

export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface CreateUploadPolicyInput {
  bucket: string;
  objectKey: string;
  contentType: string;
  /** The only object size the storage service will admit. */
  sizeBytes: bigint;
  expiresInSeconds: number;
}

/** A browser form upload (multipart POST) whose limits object storage enforces. */
export interface UploadPolicy {
  url: string;
  fields: Record<string, string>;
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
  createUploadPolicy(input: CreateUploadPolicyInput): Promise<UploadPolicy>;
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

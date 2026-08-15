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

export interface ObjectStorage {
  createUploadUrl(input: CreateUploadUrlInput): Promise<string>;
  headObject(bucket: string, objectKey: string): Promise<StoredObjectMetadata>;
}

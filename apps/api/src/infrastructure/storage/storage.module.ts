import { Global, Module } from '@nestjs/common';

import { S3StorageAdapter } from './s3-storage.adapter.js';
import { OBJECT_STORAGE } from './storage.port.js';

@Global()
@Module({
  providers: [
    S3StorageAdapter,
    { provide: OBJECT_STORAGE, useExisting: S3StorageAdapter },
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}

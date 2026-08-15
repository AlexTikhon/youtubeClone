import { Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

import { AppError } from './app-error.js';

@Injectable()
export class ZodBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Request body is invalid',
        400,
        result.error.flatten(),
      );
    }
    return result.data;
  }
}

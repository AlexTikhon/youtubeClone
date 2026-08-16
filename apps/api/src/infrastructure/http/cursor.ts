import { AppError } from './app-error.js';
import type { z } from 'zod';

export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T extends object>(
  cursor: string,
  schema: z.ZodType<T>,
): T {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    return schema.parse(parsed);
  } catch {
    throw new AppError(
      'INVALID_CURSOR',
      'The pagination cursor is invalid',
      400,
    );
  }
}

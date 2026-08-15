import { AppError } from './app-error.js';

export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T extends object>(cursor: string): T {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
    return parsed as T;
  } catch {
    throw new AppError(
      'INVALID_CURSOR',
      'The pagination cursor is invalid',
      400,
    );
  }
}

import { describe, expect, it } from 'vitest';

import { safeInternalRedirect } from './safe-internal-redirect';

describe('safeInternalRedirect', () => {
  it.each(['/watch/video-id', '/search?q=react', '/studio'])(
    'accepts the internal application path %s',
    (path) => expect(safeInternalRedirect(path)).toBe(path),
  );

  it.each([
    'https://evil.example',
    '//evil.example',
    '\\evil.example',
    '/\\evil.example',
    '/%5cevil.example',
    '/studio\nadmin',
    '/studio%0aadmin',
  ])('rejects the unsafe redirect %s', (path) =>
    expect(safeInternalRedirect(path)).toBe('/'),
  );
});

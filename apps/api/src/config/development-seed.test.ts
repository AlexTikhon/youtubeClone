import { describe, expect, it } from 'vitest';

import { resolveDevelopmentSeedPassword } from './development-seed.js';

describe('resolveDevelopmentSeedPassword', () => {
  it('keeps the convenient fallback outside production', () => {
    expect(resolveDevelopmentSeedPassword({ NODE_ENV: 'development' })).toBe(
      'youtube-clone-dev',
    );
    expect(resolveDevelopmentSeedPassword({ NODE_ENV: 'test' })).toBe(
      'youtube-clone-dev',
    );
  });

  it('requires an explicitly configured production seed password', () => {
    expect(() =>
      resolveDevelopmentSeedPassword({ NODE_ENV: 'production' }),
    ).toThrow('DEV_SEED_PASSWORD must be explicitly configured');
    expect(() => resolveDevelopmentSeedPassword({})).toThrow(
      'DEV_SEED_PASSWORD must be explicitly configured',
    );
    expect(
      resolveDevelopmentSeedPassword({
        NODE_ENV: 'production',
        DEV_SEED_PASSWORD: 'deliberately-configured-password',
      }),
    ).toBe('deliberately-configured-password');
  });
});

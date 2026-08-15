import { describe, expect, it } from 'vitest';

import { apiEnvironmentSchema, parseEnvironment } from './index.js';

const validEnvironment = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/youtube_clone',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'local-development-only',
  WEB_URL: 'http://localhost:3000',
};

describe('API environment', () => {
  it('applies safe local defaults', () => {
    const environment = parseEnvironment(
      apiEnvironmentSchema,
      validEnvironment,
    );
    expect(environment.API_PORT).toBe(4000);
    expect(environment.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('fails early when a required secret is missing', () => {
    const invalidEnvironment: Record<string, string> = { ...validEnvironment };
    Reflect.deleteProperty(invalidEnvironment, 'S3_SECRET_KEY');
    expect(() =>
      parseEnvironment(apiEnvironmentSchema, invalidEnvironment),
    ).toThrow('Invalid environment configuration');
  });
});

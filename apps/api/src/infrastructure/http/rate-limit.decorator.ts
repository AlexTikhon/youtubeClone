import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_METADATA = 'youtube-clone:rate-limit';

export interface RateLimitPolicy {
  scope: string;
  limit: number;
  windowSeconds: number;
}

export const RateLimit = (policy: RateLimitPolicy) =>
  SetMetadata(RATE_LIMIT_METADATA, policy);

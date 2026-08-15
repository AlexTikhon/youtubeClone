import { describe, expect, it } from 'vitest';
import { feedScore } from './ranking.js';
const asOf = new Date('2026-08-15T12:00:00Z');
const signal = (overrides: Partial<Parameters<typeof feedScore>[0]> = {}) => ({
  publishedAt: new Date('2026-08-15T10:00:00Z'),
  viewsCount: 10,
  likesCount: 2,
  subscribed: false,
  watchedRecently: false,
  ...overrides,
});
describe('feed ranking', () => {
  it('boosts subscriptions and penalizes recently watched videos', () => {
    expect(feedScore(signal({ subscribed: true }), asOf)).toBeGreaterThan(
      feedScore(signal(), asOf),
    );
    expect(feedScore(signal({ watchedRecently: true }), asOf)).toBeLessThan(
      feedScore(signal(), asOf),
    );
  });
  it('allows meaningful popularity to beat age', () => {
    const popular = signal({
      publishedAt: new Date('2026-08-10T00:00:00Z'),
      viewsCount: 1_000_000,
      likesCount: 50_000,
    });
    expect(feedScore(popular, asOf)).toBeGreaterThan(
      feedScore(signal({ viewsCount: 0, likesCount: 0 }), asOf),
    );
  });
});

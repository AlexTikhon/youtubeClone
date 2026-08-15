import { describe, expect, it } from 'vitest';
import {
  isViewEligible,
  resumablePosition,
  utcDayWindow,
} from './view-policy.js';

describe('watch policies', () => {
  it('requires ten seconds for normal videos and half for short videos', () => {
    expect(isViewEligible(120, 9.9)).toBe(false);
    expect(isViewEligible(120, 10)).toBe(true);
    expect(isViewEligible(8, 3.9)).toBe(false);
    expect(isViewEligible(8, 4)).toBe(true);
  });
  it('uses a stable UTC-day deduplication window', () =>
    expect(
      utcDayWindow(new Date('2026-08-15T23:59:00-07:00')).toISOString(),
    ).toBe('2026-08-16T00:00:00.000Z'));
  it('resumes only meaningful unfinished progress', () => {
    expect(resumablePosition(4, 100)).toBeNull();
    expect(resumablePosition(20.9, 100)).toBe(20);
    expect(resumablePosition(95, 100)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { formatCount, formatDuration, formatRelativeDate } from './format';

describe('presentation formatting', () => {
  it.each([
    [999, '999'],
    [1_250, '1.2K'],
    [1_400_000, '1.4M'],
  ])('formats %i as %s', (value, expected) =>
    expect(formatCount(value)).toBe(expected),
  );
  it.each([
    [65, '1:05'],
    [3661, '1:01:01'],
    [-2, '0:00'],
  ])('formats duration', (value, expected) =>
    expect(formatDuration(value)).toBe(expected),
  );
  it('formats relative dates without a date dependency', () =>
    expect(
      formatRelativeDate(
        '2026-01-01T21:00:00Z',
        new Date('2026-01-02T00:00:00Z'),
      ),
    ).toBe('3 hours ago'));
});

export function qualifyingViewSeconds(durationSeconds: number): number {
  return Math.min(10, Math.max(1, durationSeconds * 0.5));
}

export function isViewEligible(
  durationSeconds: number,
  watchedSeconds: number,
): boolean {
  return watchedSeconds >= qualifyingViewSeconds(durationSeconds);
}

export function utcDayWindow(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function resumablePosition(
  position: number,
  duration: number,
): number | null {
  return position > 5 && position < duration - 10 ? Math.floor(position) : null;
}

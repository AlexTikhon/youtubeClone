export function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  const units = [
    ['B', 1_000_000_000],
    ['M', 1_000_000],
    ['K', 1_000],
  ] as const;
  const [suffix, divisor] = units.find(([, divisor]) => value >= divisor)!;
  const scaled = value / divisor;
  const display =
    scaled >= 100 || Number.isInteger(scaled)
      ? scaled.toFixed(0)
      : (Math.floor(scaled * 10) / 10).toFixed(1);
  return `${display}${suffix}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
    : `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

export function formatRelativeDate(
  input: string | Date,
  now = new Date(),
): string {
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - new Date(input).getTime()) / 1_000),
  );
  const units = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ] as const;
  for (const [label, size] of units) {
    if (seconds >= size) {
      const value = Math.floor(seconds / size);
      return `${value} ${label}${value === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

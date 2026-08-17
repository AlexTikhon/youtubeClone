import type { ReactNode } from 'react';

export function EmptyState({
  title,
  description,
  action,
  headingLevel = 2,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <div className="rounded-2xl border border-dashed border-zinc-700 p-8 text-center sm:p-12">
      <Heading className="font-semibold text-zinc-200">{title}</Heading>
      {description && (
        <p className="mt-2 text-sm text-zinc-400">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="rounded-xl border border-red-900/80 bg-red-950/30 p-4 text-sm text-red-200"
      role="alert"
    >
      <p>{message}</p>
      {onRetry && (
        <button
          className="mt-3 rounded-lg border border-red-800 px-3 py-1.5 font-semibold hover:bg-red-950"
          onClick={onRetry}
          type="button"
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function VideoGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      aria-label="Loading videos"
      aria-live="polite"
      className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3"
      role="status"
    >
      {Array.from({ length: count }, (_, index) => (
        <div aria-hidden="true" className="animate-pulse" key={index}>
          <div className="aspect-video rounded-xl bg-zinc-800" />
          <div className="mt-3 h-5 w-4/5 rounded bg-zinc-800" />
          <div className="mt-3 h-4 w-2/5 rounded bg-zinc-800" />
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton({
  variant = 'grid',
}: {
  variant?: 'grid' | 'watch' | 'list';
}) {
  if (variant === 'watch') {
    return (
      <div aria-label="Loading video" className="animate-pulse" role="status">
        <div className="aspect-video rounded-xl bg-zinc-800" />
        <div className="mt-6 h-7 w-2/3 rounded bg-zinc-800" />
        <div className="mt-5 h-16 rounded-xl bg-zinc-900" />
      </div>
    );
  }
  if (variant === 'list') {
    return (
      <div aria-label="Loading content" className="space-y-4" role="status">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            aria-hidden="true"
            className="h-32 animate-pulse rounded-xl bg-zinc-900"
            key={index}
          />
        ))}
      </div>
    );
  }
  return <VideoGridSkeleton />;
}

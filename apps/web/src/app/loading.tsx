import { PageSkeleton } from '@/shared/ui/async-state';

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <div className="mb-8 h-9 w-40 animate-pulse rounded bg-zinc-800" />
      <PageSkeleton />
    </div>
  );
}

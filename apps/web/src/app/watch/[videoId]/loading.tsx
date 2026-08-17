import { PageSkeleton } from '@/shared/ui/async-state';

export default function WatchLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <PageSkeleton variant="watch" />
    </div>
  );
}

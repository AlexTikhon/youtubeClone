import Link from 'next/link';
import { EmptyState } from '@/shared/ui/async-state';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <EmptyState
        action={
          <Link
            className="inline-flex rounded-lg bg-red-600 px-4 py-2 font-semibold"
            href="/"
          >
            Return home
          </Link>
        }
        description="It may have been removed, made private, or never existed."
        headingLevel={1}
        title="Page not found"
      />
    </div>
  );
}

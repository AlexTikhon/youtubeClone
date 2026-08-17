'use client';

import { useEffect } from 'react';
import { InlineError } from '@/shared/ui/async-state';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Route rendering failed', error);
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="mb-5 text-2xl font-bold">This page could not be loaded</h1>
      <InlineError
        message="An unexpected page error occurred. Your account and media were not changed."
        onRetry={reset}
      />
    </div>
  );
}

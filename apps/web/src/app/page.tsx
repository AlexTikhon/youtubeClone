import Link from 'next/link';
import type { Metadata } from 'next';
import { VideoFeed } from '@/widgets/video-feed/video-feed';
import { queryKeys } from '@/shared/query/query-keys';

export const metadata: Metadata = {
  title: 'Home | YouTubeClone',
  description: 'Discover recent public videos on YouTubeClone.',
};

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold">Home</h1>
          <p className="mt-2 text-zinc-400">
            Recent, popular, and personally relevant videos.
          </p>
        </div>
        <Link
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold"
          href="/studio/upload"
        >
          Upload video
        </Link>
      </div>
      <VideoFeed
        endpoint="/api/v1/feeds/home"
        queryKey={queryKeys.feed.home}
        emptyMessage="No public videos are ready yet."
      />
    </div>
  );
}

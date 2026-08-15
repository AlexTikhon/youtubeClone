import Link from 'next/link';
import { VideoFeed } from '@/widgets/video-feed/video-feed';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
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
        queryKey={['feed', 'home']}
        emptyMessage="No public videos are ready yet."
      />
    </main>
  );
}

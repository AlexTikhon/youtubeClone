import { WatchVideo } from '@/features/video-player/watch-video';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Watch | YouTubeClone',
  robots: { index: false, follow: false },
};

export default async function WatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ videoId: string }>;
  searchParams: Promise<{ list?: string }>;
}) {
  const { videoId } = await params;
  const { list } = await searchParams;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <WatchVideo playlistId={list} videoId={videoId} />
    </div>
  );
}

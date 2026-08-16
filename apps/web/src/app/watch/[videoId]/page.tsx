import { WatchVideo } from '@/features/video-player/watch-video';

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
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
      <WatchVideo playlistId={list} videoId={videoId} />
    </main>
  );
}

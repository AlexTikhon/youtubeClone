import { WatchVideo } from '@/features/video-player/watch-video';

export default async function WatchPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 lg:px-10">
      <WatchVideo videoId={videoId} />
    </main>
  );
}

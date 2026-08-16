import { PlaylistDetail } from '@/widgets/playlist-detail/playlist-detail';

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ playlistId: string }>;
}) {
  const { playlistId } = await params;
  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
      <PlaylistDetail playlistId={playlistId} />
    </main>
  );
}

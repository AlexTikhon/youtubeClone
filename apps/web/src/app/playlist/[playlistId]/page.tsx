import { PlaylistDetail } from '@/widgets/playlist-detail/playlist-detail';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Playlist | YouTubeClone',
  robots: { index: false, follow: false },
};

export default async function PlaylistPage({
  params,
}: {
  params: Promise<{ playlistId: string }>;
}) {
  const { playlistId } = await params;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <PlaylistDetail playlistId={playlistId} />
    </div>
  );
}

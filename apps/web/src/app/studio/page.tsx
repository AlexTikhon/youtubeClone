import { StudioVideos } from '@/widgets/studio-videos/studio-videos';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Studio | YouTubeClone',
  robots: { index: false, follow: false },
};
export default function StudioPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <StudioVideos />
    </div>
  );
}

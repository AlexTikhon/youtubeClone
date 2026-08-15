import type { VideoCardDto } from '@youtube-clone/types';
import { VideoCard } from '@/entities/video/video-card';

export function VideoGrid({ videos }: { videos: VideoCardDto[] }) {
  return (
    <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
      {videos.map((video) => (
        <VideoCard key={video.id} video={video} />
      ))}
    </div>
  );
}

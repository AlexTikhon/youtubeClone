'use client';

import { useQuery } from '@tanstack/react-query';
import type { VideoCardDto } from '@youtube-clone/types';
import { VideoCard } from '@/entities/video/video-card';
import { apiRequest } from '@/shared/api/api-client';
import { queryKeys } from '@/shared/query/query-keys';
import { InlineError } from '@/shared/ui/async-state';

export function RelatedVideos({ videoId }: { videoId: string }) {
  const related = useQuery({
    queryKey: queryKeys.video.related(videoId),
    queryFn: () =>
      apiRequest<VideoCardDto[]>(`/api/v1/videos/${videoId}/related?limit=12`),
    retry: false,
  });
  return (
    <section>
      <h2 className="mb-4 text-xl font-semibold">Up next</h2>
      {related.isPending && (
        <p aria-live="polite" className="text-zinc-400" role="status">
          Loading related videos…
        </p>
      )}
      {related.isError && (
        <InlineError
          message="Related videos are unavailable."
          onRetry={() => void related.refetch()}
        />
      )}
      <div className="space-y-5">
        {related.data?.map((video) => (
          <VideoCard headingLevel={3} key={video.id} video={video} />
        ))}
      </div>
    </section>
  );
}

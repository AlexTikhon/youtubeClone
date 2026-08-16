import Link from 'next/link';
import type { VideoCardDto } from '@youtube-clone/types';
import { resolveApiUrl } from '@/shared/api/api-client';
import {
  formatCount,
  formatDuration,
  formatRelativeDate,
} from '@/shared/format/format';

export function VideoCard({
  video,
  watchHref,
  horizontal = false,
}: {
  video: VideoCardDto;
  watchHref?: string;
  horizontal?: boolean;
}) {
  const href = watchHref ?? `/watch/${video.id}`;
  return (
    <article
      className={
        horizontal
          ? 'group grid min-w-0 gap-4 sm:grid-cols-[20rem_1fr]'
          : 'group min-w-0'
      }
    >
      <Link href={href}>
        <div className="relative aspect-video overflow-hidden rounded-xl bg-zinc-800">
          {video.thumbnailUrl && (
            <img
              alt={`Thumbnail for ${video.title}`}
              className="h-full w-full object-cover transition group-hover:scale-[1.02]"
              src={resolveApiUrl(video.thumbnailUrl)}
            />
          )}
          <span className="absolute bottom-2 right-2 rounded bg-black/85 px-1.5 py-0.5 text-xs">
            {formatDuration(video.durationSeconds)}
          </span>
        </div>
        <h2
          className={`${horizontal ? 'mt-3 sm:hidden' : 'mt-3'} line-clamp-2 font-semibold leading-snug group-hover:text-red-300`}
        >
          {video.title}
        </h2>
      </Link>
      <div className={horizontal ? 'flex gap-3 sm:mt-1' : 'mt-2 flex gap-3'}>
        <div className="grid size-9 shrink-0 place-items-center rounded-full bg-zinc-700 text-sm">
          {video.channel.name.slice(0, 1).toUpperCase()}
        </div>
        <div>
          {horizontal && (
            <Link
              className="mb-2 hidden text-lg font-semibold hover:text-red-300 sm:block"
              href={href}
            >
              {video.title}
            </Link>
          )}
          <Link
            className="block text-sm text-zinc-400 hover:text-white"
            href={`/channel/${video.channel.handle}`}
          >
            {video.channel.name}
          </Link>
          <p className="mt-1 text-sm text-zinc-500">
            {formatCount(video.viewsCount)} views ·{' '}
            {formatRelativeDate(video.publishedAt)}
          </p>
        </div>
      </div>
    </article>
  );
}

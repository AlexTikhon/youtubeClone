import Link from 'next/link';
import type { VideoCardDto } from '@youtube-clone/types';
import { MediaThumbnail } from '@/shared/ui/media-thumbnail';
import {
  formatCount,
  formatDuration,
  formatRelativeDate,
} from '@/shared/format/format';

export function VideoCard({
  video,
  watchHref,
  horizontal = false,
  headingLevel = 2,
}: {
  video: VideoCardDto;
  watchHref?: string;
  horizontal?: boolean;
  headingLevel?: 2 | 3;
}) {
  const href = watchHref ?? `/watch/${video.id}`;
  const duration = formatDuration(video.durationSeconds);
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <article
      className={
        horizontal
          ? 'group grid min-w-0 gap-4 md:grid-cols-[minmax(14rem,20rem)_1fr]'
          : 'group min-w-0'
      }
    >
      <Link aria-label={`${video.title}, ${duration}`} href={href}>
        <div className="relative aspect-video overflow-hidden rounded-xl bg-zinc-800">
          <MediaThumbnail
            className="transition-transform group-hover:scale-[1.02] group-focus-within:scale-[1.02]"
            src={video.thumbnailUrl}
          />
          <span
            aria-hidden="true"
            className="absolute right-2 bottom-2 rounded bg-black/85 px-1.5 py-0.5 text-xs"
          >
            {duration}
          </span>
        </div>
        <Heading
          className={`${horizontal ? 'mt-3 md:hidden' : 'mt-3'} line-clamp-2 break-words font-semibold leading-snug group-hover:text-red-300 group-focus-within:text-red-300`}
        >
          {video.title}
        </Heading>
      </Link>
      <div
        className={
          horizontal ? 'flex min-w-0 gap-3 md:mt-1' : 'mt-2 flex min-w-0 gap-3'
        }
      >
        <div className="grid size-9 shrink-0 place-items-center rounded-full bg-zinc-700 text-sm">
          {video.channel.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          {horizontal && (
            <Link
              className="mb-2 hidden line-clamp-2 break-words text-lg font-semibold hover:text-red-300 md:block"
              href={href}
            >
              {video.title}
            </Link>
          )}
          <Link
            className="block truncate text-sm text-zinc-400 hover:text-white"
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

import { resolveApiUrl } from '@/shared/api/api-client';

export function MediaThumbnail({
  alt = '',
  className = '',
  src,
}: {
  alt?: string;
  className?: string;
  src: string | null;
}) {
  if (!src) {
    return (
      <div
        aria-hidden="true"
        className={`grid h-full w-full place-items-center bg-zinc-800 text-2xl text-zinc-600 ${className}`}
      >
        ▶
      </div>
    );
  }
  return (
    <img
      alt={alt}
      className={`h-full w-full object-cover ${className}`}
      decoding="async"
      height={360}
      loading="lazy"
      src={resolveApiUrl(src)}
      width={640}
    />
  );
}

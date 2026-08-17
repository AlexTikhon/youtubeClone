import { VideoFeed } from '@/widgets/video-feed/video-feed';
import { queryKeys } from '@/shared/query/query-keys';
export default function SubscriptionsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <h1 className="mb-8 text-3xl font-bold">Subscriptions</h1>
      <VideoFeed
        endpoint="/api/v1/feeds/subscriptions"
        queryKey={queryKeys.feed.subscriptions}
        emptyMessage="Subscribe to channels to see videos here."
      />
    </div>
  );
}

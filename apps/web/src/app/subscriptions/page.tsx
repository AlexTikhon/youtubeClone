import { VideoFeed } from '@/widgets/video-feed/video-feed';
export default function SubscriptionsPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
      <h1 className="mb-8 text-3xl font-bold">Subscriptions</h1>
      <VideoFeed
        endpoint="/api/v1/feeds/subscriptions"
        queryKey={['feed', 'subscriptions']}
        emptyMessage="Subscribe to channels to see videos here."
      />
    </main>
  );
}

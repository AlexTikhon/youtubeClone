import { ChannelView } from '@/widgets/channel-view/channel-view';
import type { Metadata } from 'next';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  return {
    title: `@${handle} | YouTubeClone`,
    description: `Watch public videos from @${handle} on YouTubeClone.`,
  };
}
export default async function ChannelPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-10">
      <ChannelView handle={handle} />
    </div>
  );
}

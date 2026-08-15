import { ChannelView } from '@/widgets/channel-view/channel-view';
export default async function ChannelPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
      <ChannelView handle={handle} />
    </main>
  );
}

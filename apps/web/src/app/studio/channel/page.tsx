import { ChannelSettingsForm } from '@/features/channel-settings/channel-settings-form';

export default function StudioChannelPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10 lg:px-10">
      <h1 className="mb-2 text-3xl font-bold">Channel settings</h1>
      <p className="mb-8 text-zinc-400">
        Edit the public name and description for your channel.
      </p>
      <ChannelSettingsForm />
    </main>
  );
}

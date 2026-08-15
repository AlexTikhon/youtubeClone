import { HistoryList } from '@/widgets/history-list/history-list';
export default function HistoryPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 lg:px-10">
      <h1 className="mb-8 text-3xl font-bold">Watch history</h1>
      <HistoryList />
    </main>
  );
}

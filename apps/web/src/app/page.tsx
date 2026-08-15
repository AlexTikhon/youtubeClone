import { VideoDraftForm } from '@/features/video-upload/video-draft-form';
import { ApiHealthQuery } from '@/widgets/api-health/api-health-query';

const foundations = [
  'Next.js App Router',
  'NestJS modular monolith',
  'PostgreSQL + Prisma',
  'Redis + BullMQ worker',
  'S3-compatible object storage',
  'Versioned processing jobs',
];

export default function HomePage() {
  return (
    <main className="mx-auto min-h-screen max-w-6xl px-6 py-10 lg:px-10 lg:py-16">
      <header className="mb-14 flex items-center justify-between border-b border-zinc-800 pb-6">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-red-600 font-bold">
            ▶
          </span>
          <span className="text-lg font-semibold tracking-tight">
            YouTubeClone
          </span>
        </div>
        <ApiHealthQuery />
      </header>

      <section className="grid gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
        <div>
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-red-400">
            Phase 0
          </p>
          <h1 className="max-w-3xl text-5xl font-bold tracking-tight text-white sm:text-6xl">
            A small video platform with serious foundations.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-400">
            This workspace focuses on explicit boundaries,
            direct-to-object-storage uploads, and a reliable asynchronous
            processing path—not a pixel-perfect YouTube replica.
          </p>
          <div className="mt-9 grid gap-3 sm:grid-cols-2">
            {foundations.map((foundation) => (
              <div
                key={foundation}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-300"
              >
                {foundation}
              </div>
            ))}
          </div>
        </div>

        <VideoDraftForm />
      </section>
    </main>
  );
}

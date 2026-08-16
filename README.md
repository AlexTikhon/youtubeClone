# YouTubeClone

YouTubeClone is an educational, production-minded video platform built to exercise the boundaries
that make media products interesting: direct uploads, asynchronous transcoding, authorized HLS
delivery, relational product state, ranked discovery, and a modern React client. It is intentionally
feature-complete as a portfolio project; the goal is explainable engineering, not a pixel-perfect or
YouTube-scale clone.

## Architecture at a glance

```text
Browser -- Next.js UI -- REST/session cookie --> NestJS modular monolith --> PostgreSQL
   |                                                |                 |
   +-- signed PUT --------------------------------> MinIO             +--> Redis/BullMQ
   |                                                                      |
   +<-- authorized thumbnail/HLS routes <---------- MinIO <--- FFmpeg worker
```

The browser uploads large originals directly to S3-compatible MinIO. The API verifies the stored
object and enqueues a versioned BullMQ job. A separately deployable worker validates media with
ffprobe and creates a thumbnail plus one 720p-bounded HLS rendition. PostgreSQL remains authoritative
for ownership, lifecycle, social state, playlists, history, and full-text search.

## Product capabilities

- Opaque server-side sessions and owned channels
- Direct signed MP4 upload, FFmpeg processing, thumbnails, and HLS playback
- Explicit video lifecycle with retry-safe jobs and deletion barriers
- Home/subscription feeds, likes, comments, subscriptions, qualified views, history, and resume
- PostgreSQL full-text search, related videos, playlists, and concurrency-safe Watch Later
- Creator Studio for metadata, visibility, processing state, and safe deletion
- Structured API errors/logs, rate limits, health checks, unit/integration/browser/media tests, and CI

## Run locally

Prerequisites: Node.js 22+, pnpm 10+, and Docker Compose. For real media processing, either install
FFmpeg/ffprobe on the host or use the optional worker container.

```powershell
Copy-Item .env.example .env # first run only
pnpm setup
pnpm dev
```

`pnpm setup` is safe to repeat: it installs the locked dependencies, starts PostgreSQL/Redis/MinIO,
applies migrations, and upserts development seed data. It does not delete volumes or reset the
database.

Open http://localhost:3000 and log in with `developer@example.test` / `youtube-clone-dev` (or your
`DEV_SEED_PASSWORD`). The API is at http://localhost:4000/api/v1, OpenAPI at
http://localhost:4000/api/docs, and the MinIO console at http://localhost:9001.

If FFmpeg is not on the host, run the containerized worker and only web/API processes locally:

```powershell
docker compose --profile media up -d --build worker
pnpm dev:app
```

Do not run the host and Compose workers simultaneously. Local worker concurrency defaults to one
because each FFmpeg process is CPU- and memory-intensive.

The seed includes a READY metadata record so the fast UI/search E2E can exercise product workflows;
it does not fabricate media bytes. Use the upload flow (or the media E2E) when demonstrating actual
playback.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test                 # unit and component tests
pnpm build
pnpm test:integration     # requires PostgreSQL and Redis
pnpm test:e2e             # fast seeded browser workflow
pnpm test:e2e:media       # opt-in real upload/FFmpeg/MinIO/HLS workflow
pnpm format:check
```

For the media suite, start the Compose worker first and set `RUN_MEDIA_E2E=true` as described in
[the video pipeline guide](docs/VIDEO_PIPELINE.md).

## Engineering decisions

The design deliberately uses a modular monolith, PostgreSQL FTS instead of Elasticsearch, polling
instead of WebSockets, cursor pagination instead of offsets, and no application DTO cache. Those
choices match the demonstrated workload while keeping consistency and invalidation understandable.

- [Architecture](docs/ARCHITECTURE.md)
- [Video pipeline](docs/VIDEO_PIPELINE.md)
- [Search](docs/SEARCH.md)
- [Decision record](docs/DECISIONS.md)
- [5–10 minute demo](docs/DEMO.md)
- [Senior interview guide](docs/INTERVIEW.md)

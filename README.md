# YouTubeClone

An educational, production-minded video platform. Phase 1 implements the first complete vertical
slice: browser login, direct upload to MinIO, asynchronous FFmpeg processing, publishing, discovery,
and HLS playback.

## Prerequisites

- Node.js 22+
- pnpm 10+
- Docker with Compose
- FFmpeg and ffprobe on `PATH` when running the worker on the host

The optional Compose worker includes FFmpeg and is useful when the host does not have it installed.

## Start locally

```powershell
Copy-Item .env.example .env # first run only
pnpm install
docker compose up -d
pnpm prisma:migrate:deploy
pnpm prisma:seed
pnpm dev
```

Open http://localhost:3000 and log in with:

- email: `developer@example.test`
- password: `youtube-clone-dev` (or the value of `DEV_SEED_PASSWORD`)

The web app is at http://localhost:3000, the API at http://localhost:4000/api/v1, OpenAPI at
http://localhost:4000/api/docs, and the MinIO console at http://localhost:9001.

If FFmpeg is not installed on the host, run only the web and API locally and use the media worker:

```powershell
docker compose --profile media up -d --build worker
pnpm build:packages
pnpm --filter @youtube-clone/web dev
pnpm --filter @youtube-clone/api dev
```

`FFMPEG_PATH` and `FFPROBE_PATH` may point to non-default executables. Video worker concurrency
defaults to one because transcoding is CPU- and memory-heavy.

## End-to-end flow

```text
login -> create owned draft -> signed PUT -> MinIO original -> complete
      -> BullMQ -> ffprobe -> thumbnail + 720p-bounded HLS -> READY
      -> public home card -> watch page -> native HLS / hls.js
```

Only MP4 uploads are accepted in Phase 1, with a 2 GB default limit. The browser MIME/size checks are
for feedback; the API verifies the stored object and the worker treats ffprobe as authoritative.

## Commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

Infrastructure-backed tests remain explicit:

```powershell
$env:RUN_INTEGRATION_TESTS='true'; pnpm --filter @youtube-clone/api test:integration
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/VIDEO_PIPELINE.md](docs/VIDEO_PIPELINE.md),
and [docs/DECISIONS.md](docs/DECISIONS.md) for boundaries, retry behavior, object layout, and Phase 1
trade-offs.

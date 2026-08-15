# YouTubeClone

A small, production-minded video platform for learning full-stack architecture. Phase 0 provides a
runnable monorepo, an authenticated draft/upload API slice, infrastructure, and a background-worker
boundary. It intentionally does not pretend to transcode or stream video yet.

## Prerequisites

- Node.js 22+
- pnpm 10+
- Docker with Compose

## Start locally

```powershell
Copy-Item .env.example .env
pnpm install
docker compose up -d
pnpm prisma:migrate:deploy
pnpm prisma:seed
pnpm dev
```

The applications are available at:

- Web: http://localhost:3000
- API: http://localhost:4000/api/v1
- OpenAPI: http://localhost:4000/api/docs
- MinIO console: http://localhost:9001

Host ports are configurable in `.env`. When changing one, update its corresponding `DATABASE_URL`,
`REDIS_URL`, or `S3_ENDPOINT` as well; internal Compose service ports do not change.

The seed command prints a one-time local session token and channel ID. Use the token as the
`ytc_session` cookie with curl/API tools. A browser login flow that issues an HTTP-only cookie is
intentionally deferred; the API already validates only hashed, server-side sessions.

## Everyday commands

```bash
pnpm dev             # web + API + worker (infrastructure must already be running)
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

Run infrastructure-backed tests explicitly after Compose is healthy:

```powershell
$env:RUN_INTEGRATION_TESTS='true'; pnpm --filter @youtube-clone/api test:integration
```

## Phase 0 API flow

1. `POST /api/v1/videos` creates a draft owned by the authenticated channel owner.
2. `POST /api/v1/videos/:id/upload` creates an upload intent and signed MinIO URL.
3. The browser uploads directly to object storage using the returned required headers.
4. `POST /api/v1/videos/:id/upload/complete` verifies size/object existence, records the original
   asset, and publishes a versioned BullMQ job.
5. The worker validates and acknowledges the job. Phase 1 will replace the explicit deferred step
   with ffprobe, thumbnail, transcoding, HLS, and final state transitions.

Architecture details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), with the future media
workflow in [docs/VIDEO_PIPELINE.md](docs/VIDEO_PIPELINE.md) and material choices in
[docs/DECISIONS.md](docs/DECISIONS.md).

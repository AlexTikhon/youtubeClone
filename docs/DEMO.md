# 5–7 minute live demo

The recommended duration is **6 minutes**. Rehearse once with the same MP4 and machine. The goal is
to show one reliable product path and two strong code decisions, not every feature.

## Before the interview

```powershell
Copy-Item .env.example .env # first run only
pnpm setup
docker compose --profile media up -d --build worker
pnpm dev:app
```

Do not run the host worker and Compose worker together. Prepare:

- one short 720p-or-larger MP4, preferably 5–15 seconds;
- one existing READY video from a rehearsal upload;
- tabs for the web app, `docs/PROJECT_WALKTHROUGH.md`,
  `apps/api/src/uploads/uploads.service.ts`,
  `apps/worker/src/video-processing.pipeline.ts`, and `.github/workflows/ci.yml`;
- a logged-in session using `developer@example.test` and the configured seed password.

Check `GET /api/v1/health/ready` and the worker's `GET /health/ready` on port 4001 before the call.
The seed intentionally contains only a metadata-only private DRAFT, so create the fallback READY
video during rehearsal rather than pretending the seed includes media.

## Script

### 1. Orient the architecture — 45 seconds

Show the overall diagram in [PROJECT_WALKTHROUGH.md](PROJECT_WALKTHROUGH.md). Say:

> The Next.js client calls a NestJS modular monolith backed by PostgreSQL. Large originals go
> directly to S3-compatible MinIO. PostgreSQL records a processing outbox event, BullMQ delivers it,
> and a separate FFmpeg worker creates an adaptive HLS master, variants, segments, and a thumbnail.

Explain that the API stays one deployable boundary because product domains share transactions, while
media work is separate because it is CPU-heavy and long-running.

### 2. Show authentication and Studio — 35 seconds

Open Studio as the seeded developer. Point out the HttpOnly server-side session model and the owner
view: status, visibility, generation, engagement counts, edit, retry, and delete. Do not spend time
opening the database unless asked.

### 3. Start a direct upload — 70 seconds

Open **Upload**, choose the short MP4, enter a clear unique title, and start. While the progress bar
moves, explain:

- NestJS creates the DRAFT and a 15-minute signed PUT intent;
- `XMLHttpRequest` PUTs bytes directly to MinIO and exposes progress/cancellation;
- upload completion HEADs the object and verifies size/content type;
- the completion transaction writes UPLOADED, generation 1, ORIGINAL, and the outbox row.

Open `UploadsService.complete` briefly if the upload is still running. Emphasize that direct upload
avoids proxying a potentially 2 GB request through the API.

### 4. Explain processing while it runs — 70 seconds

Keep Studio/upload polling visible and show the outbox/worker files. Follow this sequence:

```text
outbox publisher -> deterministic generation job -> worker PROCESSING claim
-> ffprobe -> thumbnail -> source-aware renditions -> master.m3u8
-> generation-isolated MinIO paths -> asset/READY transaction
```

State that BullMQ attempts are retries inside one processing generation. An owner retry creates a new
generation. Point to the worker's generation/status checks before upload and in the final READY
compare-and-set. Mention DELETING as the barrier that prevents a finishing worker from resurrecting a
deleted video.

### 5. Play HLS — 55 seconds

If the upload is READY, open it. Otherwise open the prepared READY video. Start playback and explain:

- a 720p source produces 360p, 480p, and 720p variants without upscaling smaller sources;
- Safari can use native HLS; other supported browsers dynamically load hls.js;
- master, variant, segment, and thumbnail requests all pass through backend authorization;
- PRIVATE and UNLISTED media are not publicly cached.

If DevTools is already open, show `master.m3u8` and one segment request. Do not spend demo time
configuring DevTools.

### 6. Show product and frontend behavior — 60 seconds

Like the video and add one comment. Explain the like mutation: optimistic video-detail cache update,
rollback on error, and server reconciliation. Watch beyond the short qualified-view threshold and
mention that a render alone does not count; authenticated forward playback must reach
`min(10 seconds, max(1 second, 50%))`, once per user/video/UTC day. Pause and point out throttled
history/resume.

Use search for the uploaded title if it is PUBLIC and READY. Explain that PostgreSQL maintains a
weighted `tsvector` and partial READY/PUBLIC GIN index. If processing is not complete, search the
prepared video's title instead.

### 7. Close on code quality — 45 seconds

Show `.github/workflows/ci.yml` and summarize:

- verify: formatting, lint, type checking, unit tests, build, and API integration with PostgreSQL,
  Redis, and initialized MinIO for the processing-retry boundary;
- browser E2E: migrations, seed, Playwright Chromium, keyboard/product flows, and failure artifacts;
- explicit heavy suites: real FFmpeg/MinIO processing and real HLS playback.

Close with the design sentence:

> The project aims for understandable, idempotent at-least-once media processing. It uses database
> constraints, generation ownership, and tests instead of claiming distributed exactly-once behavior.

## If live upload/transcoding fails during the interview

Do not debug infrastructure live for ten minutes.

1. Say that the live media dependency did not complete and move to the prepared READY video.
2. Explain the pipeline with the diagram in `PROJECT_WALKTHROUGH.md`.
3. Show `UploadsService.complete`, `ProcessingOutboxPublisher`, and the generation checks in
   `VideoProcessingPipeline`.
4. Show the real media integration test and the `@media` Playwright test as executable evidence.
5. Continue with playback, frontend mutation, search, and CI. Offer to inspect logs after the planned
   walkthrough if the interviewer wants.

If no READY video is available, show the guarded master/segment code and the real-media test rather
than presenting the seed DRAFT as playable. A calm fallback demonstrates better engineering judgment
than an improvised infrastructure repair.

## Useful follow-up locations

- `docs/CODE_TOUR.md` — quick “show me the code” index.
- `docs/FAILURE_SCENARIOS.md` — concrete recovery and limitation answers.
- `docs/VIDEO_PIPELINE.md` — full processing and object layout.
- `docs/SEARCH.md` — FTS ranking and cursor details.
- `apps/api/test/processing-retry.integration.test.ts` — concurrent generation retry.
- `apps/worker/test/media-tools.media.integration.test.ts` — real ABR generation.
- `apps/web/e2e/phase3.spec.ts` — fast and `@media` browser paths.

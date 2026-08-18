# Code tour

Use this map when an interviewer asks, “Can you show me where that is implemented?” Start with the
first file in each section; open the others for the deeper invariant or client boundary.

## Authentication

- `apps/api/src/auth/session-auth.service.ts` — login, random opaque tokens, SHA-256 token lookup,
  expiry, and revocation.
- `apps/api/src/auth/auth.controller.ts` — login/logout/me endpoints and HttpOnly cookie policy.
- `apps/api/src/auth/session.guard.ts` — authenticated request enforcement.
- `apps/api/src/auth/password.ts` — scrypt password hashing and verification.
- `apps/web/src/features/auth/auth-status.tsx` — current-session UI and logout behavior.

## Video lifecycle

- `packages/types/src/index.ts` — canonical statuses and allowed transition table.
- `apps/api/src/videos/domain/video-state-machine.ts` — API adapter for shared transition validation.
- `apps/api/src/videos/videos.service.ts` — owner updates, retry, watch access, and deletion claims.
- `apps/api/prisma/schema.prisma` — lifecycle, generation, upload, asset, and outbox persistence.

## Direct upload

- `apps/web/src/features/video-upload/video-upload-form.tsx` — draft, signed intent, upload,
  completion, cancellation, retry, and processing polling.
- `apps/web/src/shared/upload/upload-file.ts` — XMLHttpRequest PUT progress and AbortSignal bridge.
- `apps/api/src/uploads/uploads.service.ts` — signed intent, MinIO HEAD verification, completion
  transaction, ORIGINAL asset, and outbox row.
- `apps/api/src/infrastructure/storage/s3-storage.adapter.ts` — S3-compatible presign/HEAD/read/delete.
- `apps/api/src/videos/videos.controller.ts` — concrete upload routes.

## Processing outbox and queue

- `apps/api/src/infrastructure/queue/processing-outbox.publisher.ts` — pending scan, retry, publish
  marker, and retention cleanup.
- `apps/api/src/infrastructure/queue/bull-video-processing-queue.adapter.ts` — three attempts,
  exponential backoff, and deterministic enqueue.
- `apps/api/src/infrastructure/queue/video-processing-queue.port.ts` — queue port and job-ID format.
- `apps/api/prisma/schema.prisma` — unique `(videoId, generation)` outbox constraint.
- `packages/types/src/index.ts` — versioned `ProcessVideoJob` contract and queue name.

## Worker and FFmpeg

- `apps/worker/src/video-worker.service.ts` — BullMQ consumer, attempt semantics, logs, discard/fail.
- `apps/worker/src/video-processing.pipeline.ts` — claims, ownership checks, probe/transcode/upload,
  READY transaction, failure, and cleanup.
- `apps/worker/src/media-tools.service.ts` — ffprobe and FFmpeg command construction and timeouts.
- `apps/worker/src/processing-error.ts` — retryable versus terminal processing errors.
- `apps/worker/src/config.ts` — validated worker environment.

## Adaptive HLS

- `apps/worker/src/hls-renditions.ts` — source-aware 360p/480p/720p selection and master playlist.
- `apps/worker/src/media-tools.service.ts` — six-second H.264/AAC MPEG-TS rendition generation.
- `apps/worker/src/storage.service.ts` — generation-specific HLS upload and metadata.
- `apps/worker/test/media-tools.media.integration.test.ts` — real FFmpeg three-variant and
  video-only verification.

## Processing generations and retry

- `apps/api/src/videos/videos.service.ts` — FAILED-only owner retry, original verification,
  generation increment, and compare-and-set transaction.
- `apps/worker/src/video-processing.pipeline.ts` — stale checks before work/upload/commit and in fail.
- `apps/worker/src/storage.service.ts` — `generations/{generation}` object layout and cleanup.
- `apps/api/test/processing-retry.integration.test.ts` — exactly one concurrent retry and durable
  generation-2 publication.
- `apps/worker/test/processing-retry.media.integration.test.ts` — real generation-2 recovery to READY.

## Deletion barrier

- `apps/api/src/videos/videos.service.ts` — DELETING compare-and-set, object cleanup, and row removal.
- `apps/worker/src/video-processing.pipeline.ts` — lost-ownership checks and rollback/cleanup.
- `packages/types/src/index.ts` — DELETING is reachable from every active state and has no exit.
- `apps/api/src/videos/videos.service.test.ts` — deletion and cleanup behavior.

## Media authorization

- `apps/api/src/videos/videos.service.ts` — READY plus PUBLIC/UNLISTED/owner access policy.
- `apps/api/src/videos/media.controller.ts` — thumbnail, master, variant, segment allow lists,
  streaming, and public/private cache headers.
- `apps/api/src/videos/media.controller.test.ts` — traversal, cache, stream, and failure behavior.
- `apps/web/src/shared/ui/media-thumbnail.tsx` — credentialed protected thumbnail fetch/display.

## HLS player and watch tracking

- `apps/web/src/features/video-player/hls-video-player.tsx` — native HLS, dynamic hls.js, bounded
  recovery, cleanup, and playback callbacks.
- `apps/web/src/features/video-player/watch-video.tsx` — watch composition and player integration.
- `apps/web/src/features/watch-history/use-watch-tracking.ts` — qualified progress, 12-second history
  throttling, pause/end/page-hide/visibility flush.
- `apps/web/src/features/video-player/hls-video-player.test.tsx` — player behavior and cleanup tests.
- `apps/web/src/features/watch-history/use-watch-tracking.test.tsx` — tracking policy tests.

## Qualified views, history, and resume

- `apps/api/src/history/view-policy.ts` — `min(10 seconds, max(1 second, 50%))`, UTC-day window,
  resume boundaries.
- `apps/api/src/history/history.service.ts` — unique daily view, history upsert, and history listing.
- `apps/api/src/history/history.controller.ts` — authenticated view/history endpoints.
- `apps/web/src/features/watch-history/use-watch-tracking.ts` — client-side forward-watch accumulation.
- `apps/api/prisma/schema.prisma` — unique view window and WatchHistory keys.

## Search and related videos

- `apps/api/prisma/migrations/20260816010000_phase_3_discovery_playlists/migration.sql` — weighted
  `tsvector`, triggers, backfill, and partial GIN index.
- `apps/api/src/search/search.service.ts` — parameterized ranking SQL, `asOf` cursor, runtime validation,
  and related-video ranking.
- `apps/api/src/search/search.controller.ts` — public search rate limit and related endpoint.
- `apps/web/src/widgets/search-results/search-results.tsx` — query-keyed infinite result UI.
- `docs/SEARCH.md` — concise design and query-plan notes.

## Feeds and subscriptions

- `apps/api/src/feeds/feeds.service.ts` — bounded home candidates, cursor, and chronological
  subscription feed.
- `apps/api/src/feeds/ranking.ts` — recency, popularity, subscription, and recent-watch score.
- `apps/api/src/channels/channels.service.ts` — subscription persistence and channel read models.
- `apps/web/src/widgets/video-feed/video-feed.tsx` — reusable infinite feed widget.
- `apps/web/src/features/subscription/subscribe-button.tsx` — optimistic subscription mutation.

## Likes and comments

- `apps/api/src/reactions/reactions.service.ts` — idempotent like/unlike operations.
- `apps/api/src/comments/comments.service.ts` — authorized cursor list/create and deletion policy.
- `apps/web/src/features/video-like/like-button.tsx` — optimistic update, rollback, and server reconcile.
- `apps/web/src/widgets/comments-section/comments-section.tsx` — query/mutation invalidation behavior.
- `apps/api/prisma/schema.prisma` — composite like key and comment indexes.

## Playlists and Watch Later

- `apps/api/src/playlists/playlists.service.ts` — ownership, system playlist recovery, 200-item cap,
  advisory lock, order allocation, and public filtering.
- `apps/api/prisma/migrations/20260816010000_phase_3_discovery_playlists/migration.sql` — partial unique
  Watch Later index and playlist constraints.
- `apps/api/prisma/migrations/20260816020000_final_invariants/migration.sql` — Watch Later privacy
  check constraint.
- `apps/web/src/features/playlist-save/save-to-playlist-button.tsx` — playlist membership mutations.
- `apps/web/src/widgets/playlist-detail/playlist-detail.tsx` — ordered playback surface.

## Frontend structure and Server/Client Components

- `apps/web/src/app/layout.tsx` — server root composition, query provider, header, and main landmark.
- `apps/web/src/app/page.tsx` — server route composing the client feed island.
- `apps/web/src/app/watch/[videoId]/page.tsx` — async server route parameters and WatchVideo island.
- `apps/web/src/widgets/app-header/app-header.tsx` — server header around interactive client features.
- `docs/FRONTEND.md` — boundary rules, async UI, accessibility, and performance budget.

## TanStack Query

- `apps/web/src/shared/query/query-provider.tsx` — QueryClient defaults and stable browser instance.
- `apps/web/src/shared/query/query-keys.ts` — domain query-key factory.
- `apps/web/src/features/video-like/like-button.tsx` — concrete optimistic cache mutation.
- `apps/web/src/widgets/studio-videos/studio-videos.tsx` — conditional polling and targeted invalidation.
- `apps/web/src/widgets/comments-section/comments-section.tsx` — infinite query plus detail/count refresh.

## Creator Studio

- `apps/web/src/widgets/studio-videos/studio-videos.tsx` — owner list, polling, edit, retry, delete.
- `apps/web/src/features/video-upload/video-upload-form.tsx` — upload workflow and state UI.
- `apps/api/src/videos/videos.service.ts` — owner DTOs, edits, processing retry, and deletion.
- `apps/api/src/videos/videos.controller.ts` — Studio-facing video endpoints.

## API errors, validation, and rate limits

- `apps/api/src/infrastructure/http/api-exception.filter.ts` — stable error envelopes and request IDs.
- `apps/api/src/infrastructure/http/app-error.ts` — domain HTTP error type.
- `apps/api/src/infrastructure/http/rate-limit.guard.ts` — Redis fixed-window, fail-open policy.
- `packages/validation/src/index.ts` — shared Zod input contracts.
- `apps/web/src/shared/api/api-error.ts` — safe status-to-presentation mapping.

## Shared packages

- `packages/types/src/index.ts` — DTOs, lifecycle, and worker contract.
- `packages/validation/src/index.ts` — request validation schemas.
- `packages/config/src/index.ts` — API, worker, and web environment parsing.
- `packages/ui/src/status-pill.tsx` — shared presentation component.

## Tests

- `apps/api/src/**/*.test.ts` — API unit tests.
- `apps/api/test/*.integration.test.ts` — real NestJS/PostgreSQL/Redis boundaries.
- `apps/worker/src/**/*.test.ts` — worker unit tests.
- `apps/worker/test/*.media.integration.test.ts` — real FFmpeg/MinIO processing.
- `apps/web/src/**/*.test.tsx` and `apps/web/e2e/phase3.spec.ts` — component and browser tests.

## CI and local infrastructure

- `.github/workflows/ci.yml` — verify and browser-E2E jobs, PostgreSQL/Redis services, API-test MinIO,
  seed, and artifacts.
- `package.json` — root verification and test commands.
- `docker-compose.yml` — PostgreSQL, Redis, MinIO, bucket initialization, optional media worker.
- `.env.example` — documented local configuration surface.
- `apps/worker/Dockerfile` — reproducible worker with FFmpeg.

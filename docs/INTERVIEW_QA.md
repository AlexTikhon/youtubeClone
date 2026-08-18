# Senior interview questions and answers

Questions 1–30 cover the implementation. Questions 31–40 deliberately challenge the design. Keep
the short answer conversational; use the deep follow-up only when the interviewer asks.

## 1. What is the project, and what does it demonstrate?

**Short interview answer:** It is a feature-complete educational video platform built as a
TypeScript monorepo. It demonstrates direct uploads, background FFmpeg processing, authorized
adaptive HLS, transactional product state, discovery, and a modern React frontend.

**Deep follow-up:** The goal is not visual parity or YouTube scale. The important part is how the
browser, API, PostgreSQL, Redis/BullMQ, MinIO, worker, and tests meet at explicit boundaries.

**Code reference:** `README.md`; `apps/web/src`; `apps/api/src/app.module.ts`;
`apps/worker/src/app.module.ts`.

## 2. Why did you use a modular monolith?

**Short interview answer:** The product domains share one database and many transactions, so one
NestJS API keeps consistency and local development simple. NestJS modules still give clear ownership
without paying for distributed deployment too early.

**Deep follow-up:** Media processing is the exception because CPU, duration, failure, and scaling are
different. I would split a service only after a domain needed independent scale, ownership, or
availability and I had a deliberate data/contract boundary.

**Code reference:** `apps/api/src/app.module.ts`; `apps/api/src/*/*.module.ts`;
`docs/ARCHITECTURE.md`.

## 3. Why is the media worker a separate process?

**Short interview answer:** HTTP handlers should not wait for FFmpeg. The worker isolates CPU-heavy,
long-running work and gives it queue retries, controlled concurrency, and separate health checks.

**Deep follow-up:** The API and worker share only the database lifecycle and a versioned job payload.
The worker does not hold a database transaction while downloading or transcoding.

**Code reference:** `apps/worker/src/video-worker.service.ts`;
`apps/worker/src/video-processing.pipeline.ts`; `packages/types/src/index.ts`.

## 4. Why BullMQ?

**Short interview answer:** The system has one background workflow and needs durable jobs, retry with
backoff, concurrency control, and Node.js integration. BullMQ provides those features with the Redis
already used by the API.

**Deep follow-up:** Each job has three BullMQ attempts with exponential backoff. Those attempts are
not processing generations; they retry the same logical generation.

**Code reference:** `apps/api/src/infrastructure/queue/bull-video-processing-queue.adapter.ts`;
`apps/worker/src/video-worker.service.ts`.

## 5. What problem does the transactional outbox solve?

**Short interview answer:** It closes the database/queue dual-write gap. Upload completion commits
the lifecycle change, original asset, generation, and outbox row together; queue publication happens
afterward and can be retried.

**Deep follow-up:** If enqueue succeeds but marking published fails, the publisher may repeat. The
unique outbox key and deterministic BullMQ ID make publication idempotent. The design is at-least-once,
not exactly-once.

**Code reference:** `apps/api/src/uploads/uploads.service.ts`;
`apps/api/src/infrastructure/queue/processing-outbox.publisher.ts`;
`apps/api/prisma/schema.prisma`.

## 6. What happens if the same processing job is delivered twice?

**Short interview answer:** The worker checks status and generation. READY duplicates return without
processing, stale generations return without processing, and concurrent work must still win
compare-and-set ownership before publishing READY.

**Deep follow-up:** Generation-specific paths and asset upserts protect stored output. Duplicate
execution may waste CPU, but it cannot intentionally make an old result authoritative.

**Code reference:** `apps/worker/src/video-processing.pipeline.ts`;
`apps/worker/src/storage.service.ts`.

## 7. What is a processing generation?

**Short interview answer:** It is one logical processing run. Initial completion creates generation
1; an accepted owner retry increments it. BullMQ retries inside a generation do not increment it.

**Deep follow-up:** This distinction prevents a delayed old job from overwriting a newer user-requested
run. The database generation is checked at every publication boundary.

**Code reference:** `apps/api/src/videos/videos.service.ts`;
`apps/worker/src/video-processing.pipeline.ts`; `docs/VIDEO_PIPELINE.md`.

## 8. How do you avoid stale processing workers?

**Short interview answer:** The job carries a generation, and the worker compares it with the video
row before work, before upload, before commit, and in the final PROCESSING-to-READY update. A mismatch
is a successful no-op.

**Deep follow-up:** Failure recording also requires matching PROCESSING plus generation, so an old job
cannot mark a newer run FAILED. Generated object prefixes contain the generation as a second barrier.

**Code reference:** `apps/worker/src/video-processing.pipeline.ts`;
`apps/worker/src/storage.service.ts`.

## 9. What happens if deletion races with transcoding?

**Short interview answer:** Deletion first compare-and-sets DELETING. That blocks playback and means
the worker no longer owns PROCESSING, so its final READY claim fails and its generated prefix is
cleaned.

**Deep follow-up:** Storage deletion happens outside the database transaction. The row is deleted only
after cleanup succeeds; otherwise it remains DELETING for an idempotent retry.

**Code reference:** `apps/api/src/videos/videos.service.ts`;
`apps/worker/src/video-processing.pipeline.ts`.

## 10. Why upload directly to MinIO instead of through NestJS?

**Short interview answer:** Large bytes do not need to consume API bandwidth or hold a large NestJS
request open. The API authorizes a short-lived intent, and the browser PUTs directly to object storage.

**Deep follow-up:** Completion does not trust the browser; the API HEADs the object and verifies
non-empty size, expected size, and content type before recording the ORIGINAL and outbox event.

**Code reference:** `apps/api/src/uploads/uploads.service.ts`;
`apps/web/src/shared/upload/upload-file.ts`;
`apps/api/src/infrastructure/storage/s3-storage.adapter.ts`.

## 11. How is the video lifecycle enforced?

**Short interview answer:** A shared transition table defines DRAFT, UPLOADING, UPLOADED, PROCESSING,
READY, FAILED, and DELETING. Services validate transitions and use status-sensitive `updateMany`
claims when races matter.

**Deep follow-up:** This rejects actions such as retrying READY, completing from the wrong state, or
publishing after deletion. The transition table documents intent; compare-and-set updates enforce
concurrent ownership.

**Code reference:** `packages/types/src/index.ts`;
`apps/api/src/videos/domain/video-state-machine.ts`; `apps/api/src/uploads/uploads.service.ts`.

## 12. Why HLS instead of serving the original MP4?

**Short interview answer:** HLS gives a master playlist and multiple bitrates so the player can adapt
to network and device conditions. It also gives the server a clear authorization point for each
manifest and segment.

**Deep follow-up:** This project uses a compatibility-oriented H.264/AAC MPEG-TS ladder and six-second
segments. It is not claiming a globally optimized streaming stack.

**Code reference:** `apps/worker/src/media-tools.service.ts`;
`apps/worker/src/hls-renditions.ts`; `apps/api/src/videos/media.controller.ts`.

## 13. How do you prevent unnecessary upscaling?

**Short interview answer:** The worker probes source dimensions and selects only ladder heights at or
below the source. A source below 360p gets one bounded `source` rendition.

**Deep follow-up:** Width is scaled to an even value without exceeding the source. Audio-less input
omits AAC rather than inventing an audio stream.

**Code reference:** `apps/worker/src/hls-renditions.ts`;
`apps/worker/src/hls-renditions.test.ts`.

## 14. How do you secure PRIVATE HLS segments?

**Short interview answer:** React visibility is not the security boundary. Every thumbnail, master,
variant, and segment request goes through `MediaController`, which asks `VideosService` for READY and
visibility/owner access before reading MinIO.

**Deep follow-up:** Paths are allow-listed to prevent traversal. PUBLIC responses are long-lived and
cacheable; PRIVATE and UNLISTED responses are `private, no-store`. At scale I would move bytes to a
CDN with signed cookies/URLs while keeping backend authorization authoritative.

**Code reference:** `apps/api/src/videos/media.controller.ts`;
`apps/api/src/videos/videos.service.ts`.

## 15. How does authentication work?

**Short interview answer:** Login verifies a scrypt password and creates a random opaque session
token. PostgreSQL stores only its SHA-256 hash; the browser receives the raw token in an HttpOnly,
SameSite=Lax cookie that is Secure in production.

**Deep follow-up:** Every guarded request checks expiry and revocation. Logout marks the session
revoked and clears the cookie. The repository deliberately has a seeded login rather than full
registration/OAuth flows.

**Code reference:** `apps/api/src/auth/session-auth.service.ts`;
`apps/api/src/auth/auth.controller.ts`; `apps/api/src/auth/password.ts`.

## 16. Why TanStack Query instead of Redux?

**Short interview answer:** Most shared client state is remote server state. TanStack Query already
handles cache identity, deduplication, pagination, polling, and mutation lifecycles; local interaction
state stays in React.

**Deep follow-up:** Redux could be justified by a complex offline editor, collaborative client state,
or cross-route workflows that are not mainly a server cache. It is not a bad tool; it currently solves
no demonstrated gap here.

**Code reference:** `apps/web/src/shared/query/query-provider.tsx`;
`apps/web/src/shared/query/query-keys.ts`; `apps/web/src/widgets/studio-videos/studio-videos.tsx`.

## 17. Show one concrete TanStack Query mutation.

**Short interview answer:** The like button cancels the video-detail query, snapshots it,
optimistically changes `likedByCurrentUser` and `likesCount`, rolls back on error, and reconciles with
the server response on success.

**Deep follow-up:** The mutation touches only `['video', videoId]`; it does not clear unrelated caches.
Authentication errors redirect to login, while other failures are announced and restore the previous
choice.

**Code reference:** `apps/web/src/features/video-like/like-button.tsx`;
`apps/web/src/features/video-like/like-button.test.tsx`.

## 18. How do Server and Client Components coexist?

**Short interview answer:** Route files and static composition stay server-side. Client Components are
focused around React Query, forms, state/effects, event handlers, and browser APIs.

**Deep follow-up:** `WatchPage` is server composition, `WatchVideo` owns query-driven interaction,
and `HlsVideoPlayer` is a smaller browser-media island. `AppHeader` is server-side around client search
and auth islands. This reduces unnecessary client boundaries without claiming universal speedups.

**Code reference:** `apps/web/src/app/watch/[videoId]/page.tsx`;
`apps/web/src/features/video-player/watch-video.tsx`;
`apps/web/src/features/video-player/hls-video-player.tsx`.

## 19. How is HLS loaded efficiently in the browser?

**Short interview answer:** The player uses native HLS when available. Otherwise it dynamically
imports hls.js inside an effect, so non-watch pages do not load playback implementation JavaScript.

**Deep follow-up:** Credentialed requests preserve private-media sessions. Cleanup destroys hls.js,
removes listeners/source, and reloads the media element. Fatal recovery is bounded before showing a
manual retry.

**Code reference:** `apps/web/src/features/video-player/hls-video-player.tsx`.

## 20. How do you separate server state from local UI state?

**Short interview answer:** Data that can become stale independently—feeds, detail, comments,
playlists, Studio, session—uses query keys. Ephemeral state such as input values, dialog visibility,
upload progress, and player error display remains local.

**Deep follow-up:** This makes refetch/invalidation explicit while keeping short-lived interaction
close to its component. The API client normalizes credentials and error envelopes at one boundary.

**Code reference:** `apps/web/src/shared/query/query-keys.ts`;
`apps/web/src/shared/api/api-client.ts`; `apps/web/src/widgets/studio-videos/studio-videos.tsx`.

## 21. Why PostgreSQL full-text search instead of Elasticsearch?

**Short interview answer:** The current data and requirements fit PostgreSQL FTS, so another
distributed system would add synchronization and operations without a measured benefit.

**Deep follow-up:** Triggers maintain a weighted `tsvector`, a partial GIN index covers public READY
rows, and parameterized SQL uses `websearch_to_tsquery` plus rank/popularity/recency. I would migrate
for much larger independent search load, stronger typo tolerance, richer language analysis, facets,
or product requirements PostgreSQL could not meet.

**Code reference:** `apps/api/prisma/migrations/20260816010000_phase_3_discovery_playlists/migration.sql`;
`apps/api/src/search/search.service.ts`.

## 22. How does pagination remain stable enough for ranked search?

**Short interview answer:** The first search page captures an `asOf` timestamp, and the cursor carries
it with rounded rank, published time, and ID. Later pages reuse that ranking time and keyset ordering.

**Deep follow-up:** Freezing time removes recency-score drift, but live view changes can still reorder
rows. Immutable ranking snapshots would add storage and are not justified for this project.

**Code reference:** `apps/api/src/search/search.service.ts`; `docs/SEARCH.md`.

## 23. How does the home feed rank videos?

**Short interview answer:** It is a transparent heuristic over a bounded union of recent, popular,
and subscribed candidates. The score combines recency, log-scaled views/likes, a subscription boost,
and a penalty for videos watched recently.

**Deep follow-up:** Candidate windows are capped, `asOf` is frozen in the cursor, and the application
sorts only that bounded union. This is not ML or an infinite recommendation archive.

**Code reference:** `apps/api/src/feeds/feeds.service.ts`;
`apps/api/src/feeds/ranking.ts`.

## 24. How would recommendations change at real scale?

**Short interview answer:** I would introduce an event pipeline, offline/streaming feature generation,
candidate generators, a ranking model, and offline plus online evaluation.

**Deep follow-up:** I would separate retrieval from ranking, handle freshness and feedback loops, and
measure watch-quality outcomes. That is future large-scale architecture, not something implemented in
this repository.

**Code reference:** Current baseline: `apps/api/src/feeds/feeds.service.ts` and
`apps/api/src/search/search.service.ts`.

## 25. How do qualified views work?

**Short interview answer:** An authenticated player must accumulate small forward progress until
`min(10 seconds, max(1 second, 50% of duration))`. PostgreSQL then permits one counted view per
user/video/UTC day.

**Deep follow-up:** Large seeks do not add watch time because client deltas must be positive and under
two seconds. The server validates the threshold again. This reduces accidental counts but is not a
fraud/abuse system.

**Code reference:** `apps/web/src/features/watch-history/use-watch-tracking.ts`;
`apps/api/src/history/view-policy.ts`; `apps/api/src/history/history.service.ts`.

## 26. How is playback progress stored efficiently?

**Short interview answer:** Progress stays local during normal time updates and persists at most about
every 12 seconds. Pause and end flush it, and page-hide/hidden visibility uses a keepalive request.

**Deep follow-up:** The API floors and clamps the position before a WatchHistory upsert. Resume is
shown only above five seconds and more than ten seconds from the end, avoiding unhelpful resumes.

**Code reference:** `apps/web/src/features/watch-history/use-watch-tracking.ts`;
`apps/api/src/history/history.service.ts`; `apps/api/src/videos/videos.service.ts`.

## 27. What playlist concurrency problem did you handle?

**Short interview answer:** Concurrent `MAX(position) + 1` writes could choose the same order. The add
transaction takes a PostgreSQL transaction-scoped advisory lock for that playlist before checking
membership, capacity, and allocating the next position.

**Deep follow-up:** Composite keys prevent duplicate membership, a unique position constraint protects
ordering, and a partial unique index permits one Watch Later playlist per owner. Creation recovers
from the unique race.

**Code reference:** `apps/api/src/playlists/playlists.service.ts`;
`apps/api/prisma/migrations/20260816010000_phase_3_discovery_playlists/migration.sql`.

## 28. How are API failures presented safely?

**Short interview answer:** The API returns a consistent error envelope with code, safe message, and
request ID. Unexpected 5xx details go to server logs, not the browser. The frontend maps status to a
small presentation vocabulary.

**Deep follow-up:** Local query regions can retry without collapsing the page, optimistic mutations
roll back, and the player has its own bounded error state. Request IDs connect client reports with
structured logs.

**Code reference:** `apps/api/src/infrastructure/http/api-exception.filter.ts`;
`apps/web/src/shared/api/api-error.ts`; `apps/web/src/shared/ui/async-state.tsx`.

## 29. What accessibility work is concrete?

**Short interview answer:** The app has a skip link and main landmark, labelled forms, accessible
errors/status, keyboard-friendly native controls, and an accessible dialog with focus movement,
trapping, Escape close, and focus restoration.

**Deep follow-up:** Video cards have distinct video/channel links, reduced-motion preferences are
respected, and Playwright tests the keyboard skip/search flow. Accessibility is part of component
behavior rather than an afterthought document.

**Code reference:** `apps/web/src/app/layout.tsx`;
`apps/web/src/shared/ui/accessible-dialog.tsx`; `apps/web/e2e/phase3.spec.ts`.

## 30. What does CI verify, and what remains opt-in?

**Short interview answer:** CI runs formatting, lint, types, unit tests, builds, API integration tests,
and a separate Chromium workflow with migrations, seed, and failure artifacts. Real FFmpeg/media
tests are explicit opt-in suites.

**Deep follow-up:** The verify job uses PostgreSQL and Redis services and starts MinIO for the API
processing-retry integration boundary. Browser E2E installs Chromium with dependencies. Real media
also needs FFmpeg and performs actual encoding, so separating it keeps routine feedback proportional
to this portfolio project.

**Code reference:** `.github/workflows/ci.yml`; `package.json`;
`apps/worker/test/media-tools.media.integration.test.ts`; `apps/web/e2e/phase3.spec.ts`.

# Architecture challenge questions

## 31. Why didn't you use Kafka?

**Short interview answer:** One media workflow needs a job queue, retries, and bounded worker
concurrency; BullMQ fits that problem with lower operational cost. Kafka would not remove the need for
idempotency or the database outbox.

**Deep follow-up:** BullMQ depends on Redis and is not a general replayable event backbone. I would
consider Kafka when many independent consumers, high event throughput, long retention/replay, and
cross-domain event ownership became real requirements.

**Code reference:** `apps/api/src/infrastructure/queue/bull-video-processing-queue.adapter.ts`;
`docs/DECISIONS.md`.

## 32. Why isn't the API split into microservices?

**Short interview answer:** A single team-sized application with one transactional database benefits
from a modular monolith. Splitting it now would create network contracts, deployment work, and
distributed consistency without independent scaling evidence.

**Deep follow-up:** The trade-off is that API modules deploy together. I would extract a boundary
when its change rate, ownership, scale, availability, or data model clearly diverged; the FFmpeg worker
already demonstrates that rule.

**Code reference:** `apps/api/src/app.module.ts`; `apps/worker/src/app.module.ts`.

## 33. Why not use WebSockets for processing status?

**Short interview answer:** Studio polls every two seconds only while a row is UPLOADED or PROCESSING
and stops at READY/FAILED. That is simple and sufficient for a low-frequency workflow.

**Deep follow-up:** Polling adds bounded repeated requests and up to about two seconds of delay. I
would move to SSE/WebSockets if many concurrent long-running workflows, stronger immediacy, or a
general notification channel justified connection authorization and fan-out infrastructure.

**Code reference:** `apps/web/src/widgets/studio-videos/studio-videos.tsx`;
`apps/web/src/features/video-upload/video-upload-form.tsx`.

## 34. Why not upload the video through NestJS?

**Short interview answer:** The API still authorizes and verifies the upload, but proxying up to 2 GB
would add bandwidth, backpressure, timeout, and scaling responsibilities that object storage already
solves.

**Deep follow-up:** Direct single PUT does not support multipart resume, and interrupted uploads need
better lifecycle cleanup. I would add multipart uploads, persisted resume UI, and abandoned-upload
retention if upload reliability became a product requirement.

**Code reference:** `apps/api/src/uploads/uploads.service.ts`;
`apps/web/src/shared/upload/upload-file.ts`.

## 35. Why MinIO?

**Short interview answer:** It gives a reproducible local S3-compatible object store and keeps media
bytes outside PostgreSQL. The code uses AWS SDK abstractions rather than MinIO-specific data APIs.

**Deep follow-up:** Local MinIO is not a global durable media service or CDN. A deployed system would
choose managed object storage, lifecycle policies, replication, and a CDN based on the environment.

**Code reference:** `docker-compose.yml`;
`apps/api/src/infrastructure/storage/s3-storage.adapter.ts`;
`apps/worker/src/storage.service.ts`.

## 36. Why HLS, and why MPEG-TS rather than newer packaging?

**Short interview answer:** HLS gives adaptive playback with native Safari support and hls.js
elsewhere. H.264/AAC MPEG-TS is a conservative compatibility baseline that is easy to inspect and
test.

**Deep follow-up:** It is less storage/bandwidth efficient than newer codecs and CMAF can unify
packaging better. I would add codec/package ladders based on device analytics, cost, DRM, and latency
requirements, not simply because they are newer.

**Code reference:** `apps/worker/src/media-tools.service.ts`;
`apps/web/src/features/video-player/hls-video-player.tsx`.

## 37. Why not Elasticsearch?

**Short interview answer:** PostgreSQL already owns the data and meets the current weighted search
requirements. Elasticsearch would add replication lag, index pipelines, monitoring, and another
failure boundary.

**Deep follow-up:** PostgreSQL ranking includes live aggregation and has limited advanced relevance
features. I would change when measured query load, corpus size, typo tolerance, multilingual
analysis, facets, or independent search availability required a dedicated platform.

**Code reference:** `apps/api/src/search/search.service.ts`;
`apps/api/prisma/migrations/20260816010000_phase_3_discovery_playlists/migration.sql`.

## 38. Why polling instead of events throughout the frontend?

**Short interview answer:** Most data changes after user actions and is well served by mutation cache
updates or targeted invalidation. Processing is the only periodic case, and its bounded poll stops at
terminal state.

**Deep follow-up:** The trade-off is freshness versus request volume. I would introduce server push
for a measured real-time product need, while still using query keys to merge pushed events with
fetch/reconnect consistency.

**Code reference:** `apps/web/src/shared/query/query-keys.ts`;
`apps/web/src/widgets/studio-videos/studio-videos.tsx`.

## 39. Why not Redux?

**Short interview answer:** Remote state is already modelled by TanStack Query and local UI state is
small. Adding Redux now would create a second cache/state protocol without a specific missing use case.

**Deep follow-up:** TanStack Query is not a replacement for every client state machine. I would use
Redux or another state tool for a complex offline-first editor, command history, collaborative state,
or deeply shared deterministic UI workflow.

**Code reference:** `apps/web/src/shared/query/query-provider.tsx`;
`apps/web/src/shared/query/query-keys.ts`.

## 40. Why aren't real FFmpeg tests run on every push?

**Short interview answer:** The default CI already covers logic, API integration, browser workflows,
and builds. Real encoding adds FFmpeg, MinIO, CPU time, and more environmental failure modes, so it is
kept as an explicit high-value suite.

**Deep follow-up:** The trade-off is slower detection of media-tool/environment regressions. I would
run it in a nightly or release workflow, or every PR for a production media team with suitable cached
fixtures and capacity. The repository still keeps the commands and real assertions versioned.

**Code reference:** `.github/workflows/ci.yml`;
`apps/worker/test/media-tools.media.integration.test.ts`;
`apps/web/e2e/phase3.spec.ts`.

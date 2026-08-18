# Project walkthrough

This is the main interview study guide. The first three sections tell the same story at different
depths. The remaining sections are a reference for follow-up questions.

## 30 seconds: recruiter or HR

YouTubeClone is a production-minded educational video platform built as a TypeScript monorepo. I
built it to practise the engineering boundaries behind a media product, not to reproduce every
YouTube feature. It combines a Next.js and React frontend, a NestJS API, PostgreSQL, Redis and
BullMQ, MinIO object storage, and a separate FFmpeg worker. The strongest parts are direct uploads,
adaptive HLS playback, reliable asynchronous processing, authorization, and a tested frontend with
clear server/client boundaries.

## 2 minutes: hiring manager

YouTubeClone is a feature-complete portfolio video platform. The web application uses Next.js App
Router, React, and TanStack Query. The NestJS API is a modular monolith backed by PostgreSQL. Large
original files upload from the browser directly to S3-compatible MinIO, and a separate NestJS worker
uses BullMQ, ffprobe, and FFmpeg to create a thumbnail and a source-aware adaptive HLS ladder.

I kept request/response product logic in one API because the domains share transactions and the
project does not need microservice operational overhead. Media processing is separate because it is
CPU-heavy, long-running, and has different retry and deployment needs.

The most important reliability decision is a transactional outbox. Upload completion updates the
database and inserts a processing event in one PostgreSQL transaction. A publisher later sends that
event to BullMQ with a deterministic job ID. This avoids losing work when the database commit
succeeds but Redis is temporarily unavailable. Processing uses logical generations: an owner retry
increments the generation, and every important worker claim compares the job generation with the
database. Delayed work from an older generation therefore becomes a safe no-op.

The frontend uses TanStack Query for remote state and React state for local interaction. Route
composition stays server-side where practical, while focused Client Components own queries, forms,
media APIs, and effects. Playback uses native HLS when the browser supports it and dynamically loads
`hls.js` otherwise. The repository includes unit tests, API integration tests, Playwright workflows,
and opt-in real FFmpeg/media tests.

## 7 minutes: technical interview

### 1. Introduction — about 30 seconds

YouTubeClone is a production-minded educational video platform in a TypeScript monorepo. I built it
to explore the difficult boundaries of a media system: large uploads, asynchronous transcoding,
authorized adaptive playback, concurrent lifecycle changes, and a responsive React client. The web
app is Next.js and React, the API is a NestJS modular monolith, PostgreSQL owns transactional state,
Redis and BullMQ coordinate processing, MinIO stores media, and a separate NestJS worker runs
ffprobe and FFmpeg. It demonstrates end-to-end engineering choices rather than YouTube-scale claims.

### 2. Architecture — about 60–90 seconds

```text
Browser -- REST + HttpOnly session --> Next.js UI --> NestJS API --> PostgreSQL
   |                                                     |             |
   +---------------- signed PUT ----------------------> MinIO          |
                                                         ^             v
authorized thumbnail/HLS <------- NestJS API <-----------+     outbox publisher
                                                                       |
                                                                       v
                                                                 Redis / BullMQ
                                                                       |
                                                                       v
                                                              separate NestJS worker
                                                               ffprobe + FFmpeg
                                                                       |
                                                                       v
                                                          thumbnail + HLS -> MinIO
```

- The NestJS API is a modular monolith because authentication, channels, videos, social data,
  playlists, and history share one transactional model. Module boundaries remain explicit without
  adding distributed deployment and consistency problems.
- The worker is separate because FFmpeg is CPU-heavy and long-running. It can restart, retry, and
  scale independently from latency-sensitive HTTP requests.
- PostgreSQL is authoritative for sessions, ownership, lifecycle, assets, engagement, playlists,
  history, the processing outbox, and full-text search. These domains benefit from constraints and
  transactions.
- Redis/BullMQ provides a durable job queue, retry/backoff, and worker concurrency for the one
  asynchronous pipeline. Redis is not the source of truth for video lifecycle state.
- MinIO provides the S3 API and keeps large binary objects outside PostgreSQL. The same adapter can
  target S3-compatible storage in another environment.
- HLS gives adaptive playback through a master playlist and source-aware variants instead of making
  every client download the original MP4 at one bitrate.

### 3. One upload from selection to playback — about 2 minutes

```text
user selects MP4
      |
      v
VideoUploadForm -> POST /api/v1/videos                 -> DRAFT
      |
      v
POST /api/v1/videos/:id/upload
      |  UploadsService records VideoUpload + UPLOADING
      |  S3StorageAdapter returns a 15-minute signed PUT
      v
browser XMLHttpRequest -------------------------------> MinIO original
      |  progress and AbortSignal stay in the browser
      v
POST /api/v1/videos/:id/upload/complete
      |  HEAD verifies size and content type
      v
PostgreSQL transaction
      +-- UPLOADING -> UPLOADED; generation 1
      +-- mark VideoUpload COMPLETED
      +-- upsert ORIGINAL VideoAsset
      +-- upsert ProcessingOutbox
      |
      v
ProcessingOutboxPublisher -> deterministic BullMQ job
      |
      v
VideoWorkerService -> VideoProcessingPipeline
      +-- claim UPLOADED -> PROCESSING
      +-- download and verify original length
      +-- ffprobe metadata
      +-- FFmpeg thumbnail
      +-- sequential source-aware HLS renditions
      +-- master.m3u8
      +-- upload generation-isolated assets to MinIO
      +-- transactionally record assets and claim PROCESSING -> READY
      |
      v
Studio polling observes READY; watch page receives an authorized playback URL
```

The direct browser-to-storage PUT matters because NestJS does not have to buffer or stream a request
up to 2 GB, spend API bandwidth on the original, or keep a large HTTP request open. The API still
controls ownership, intent, permitted content type and size, and completion verification. This is a
scalability-friendly boundary without claiming large production traffic.

### 4. Transactional outbox — about 60 seconds

The unsafe dual write would be:

```ts
await prisma.video.update(...);
await queue.add(...);
```

If the database commits and the API process crashes before `queue.add`, the video is durable but no
job exists. `UploadsService.complete` instead performs this short transaction:

```text
PostgreSQL transaction
   +-- upload/lifecycle state
   +-- ORIGINAL asset
   +-- processing generation
   +-- unique ProcessingOutbox(videoId, generation)
COMMIT
          |
          v
ProcessingOutboxPublisher -- video-{videoId}-generation-{generation} --> BullMQ
```

The publisher scans unpublished rows every second and on API startup. A failed Redis write leaves the
row unpublished for retry. If enqueue succeeds but marking the row published fails, publication can
repeat; the deterministic BullMQ job ID and unique outbox key make that safe. We aim for idempotent
at-least-once behavior rather than pretending distributed exactly-once delivery exists.

### 5. Processing generations and deletion — about 60 seconds

```text
generation 1 fails
      |
owner retry compare-and-sets FAILED
      |
generation 2 + new outbox row
      |
old generation 1 BullMQ retry wakes
      |
job generation 1 != database generation 2 -> stale successful no-op
```

A processing generation is a logical owner-requested run. A BullMQ attempt is only an infrastructure
retry inside that generation; the queue allows three attempts with exponential backoff. The worker
checks generation and status when it receives the job, before generated upload, before the final
commit, and inside the compare-and-set that changes PROCESSING to READY. Generated keys include
`videos/{videoId}/generations/{generation}/`, so an old run cannot overwrite a newer run's bytes.

Deletion uses the same ownership idea. `VideosService.delete` first compare-and-sets the row to
DELETING, which immediately blocks watch/media access and worker completion. Storage cleanup occurs
outside a database transaction. If a worker finishes after deletion starts, its pre-commit check or
final READY compare-and-set fails, its asset transaction rolls back, and it removes that generation's
objects. Only successful deletion cleanup removes the database row; cleanup failure leaves DELETING
so the owner can retry.

### 6. Frontend, playback, and product reads — about 90 seconds

The frontend follows `app`, `widgets`, `features`, `entities`, and `shared` boundaries. `app` owns
routing and composition; `widgets` combine page sections such as `VideoFeed`, `StudioVideos`, and
`CommentsSection`; `features` own use cases such as upload, like, subscription, and playback;
`entities` present domain objects such as `VideoCard`; `shared` contains the API client, query keys,
generic UI, formatting, and upload transport.

Route files such as `app/page.tsx` and `app/watch/[videoId]/page.tsx` remain Server Components.
`VideoFeed`, `WatchVideo`, and `StudioVideos` are Client Components because they use TanStack Query
and event handlers. `HlsVideoPlayer` is a still narrower client island because it needs the browser
media element, effects, and dynamic `hls.js` loading. `AppHeader` is server composition around the
interactive `SearchForm` and `AuthStatus`. The rule is to use Client Components for interaction,
browser APIs, local state/effects, or React Query, and otherwise keep composition server-side where
practical. This limits client-only boundaries and playback-specific JavaScript; it is not a claim
that Server Components are always faster.

TanStack Query owns remote state: feeds, video detail, comments, playlists, Studio, likes, and
subscriptions. Local form fields, dialog visibility, player UI, and upload progress remain React
state. Query keys encode cache identity and let mutations refresh only affected domains. For example,
`LikeButton` cancels the video-detail query, stores the previous value, optimistically flips the like
and count, rolls back on error, and replaces the cache with the server result on success. It does not
invalidate the entire application.

The player first checks native HLS support. Otherwise it imports `hls.js` inside an effect, enables
credentialed manifest/segment requests, and destroys the instance and media source on cleanup.
Fatal hls.js network recovery is capped at two attempts and media recovery at one; exhaustion shows
a retry action. Feed, search, playlist, and channel pages never import the playback chunk.

### 7. Discovery, watch semantics, and verification — about 60 seconds

PostgreSQL full-text search is sufficient for this workload. Database triggers maintain a weighted
`tsvector`: title is weight A, channel name/handle B, and description C. A partial GIN index covers
READY/PUBLIC rows. `websearch_to_tsquery('english', q)` drives matching; rounded `ts_rank_cd` dominates
small bounded popularity and recency signals. Query normalization, a 160-character cap, parameterized
Prisma SQL, runtime row validation, and a frozen `asOf` cursor make the boundary explicit. A separate
search service would become useful for much larger data, typo tolerance, language-specific analysis,
complex facets, or independent search scaling—not for the current repository.

The home feed is also intentionally interpretable, not ML. It ranks a bounded union of up to 150
recent, 75 popular, and 75 subscribed candidates. The score combines recency, log views/likes, a
subscription boost, and a recent-watch penalty. Subscriptions are a chronological public feed.
Related videos use same-channel and title/search-vector relevance with small popularity and recency
signals. A large-scale recommender would add an event pipeline, feature generation, candidate
generation, ranking models, and offline/online evaluation.

A page render does not count a view. An authenticated player accumulates only small forward progress
deltas and submits after `min(10 seconds, max(1 second, 50% of duration))`. PostgreSQL permits one
view per user/video/UTC day. This is meaningful qualification for the project, not fraud detection. History
is saved at most about every 12 seconds and on pause, end, page hide, or visibility becoming hidden;
resume is offered only after five seconds and more than ten seconds before completion.

CI has a verify job with PostgreSQL and Redis plus an initialized MinIO container for the processing
retry integration boundary. It installs locked dependencies, deploys migrations, runs formatting,
lint, type checking, unit tests, builds, and API integration tests. A separate
Chromium job migrates, seeds, installs Playwright, runs the fast browser suite, and uploads failure
artifacts. Real FFmpeg/media integration and playback E2E suites are explicit local/opt-in commands
because encoding on every push would make the default feedback loop slower and require MinIO/FFmpeg
in CI.

## Video lifecycle

The shared transition table in `packages/types/src/index.ts` and the API state-machine adapter define
the lifecycle:

```text
DRAFT ---------> UPLOADING ---------> UPLOADED ---------> PROCESSING ---------> READY
  |                   |                   |                    |
  |                   +----> FAILED <-----+--------------------+
  |                              |
  |                              +--------> PROCESSING (new generation)
  |
  +------------------------------ allowed states --------------------> DELETING

DELETING has no outgoing transition; successful cleanup deletes the row.
```

In the actual transition table, UPLOADING and UPLOADED may also move to FAILED, although current
normal worker failure happens after PROCESSING. Every non-DELETING state can transition to DELETING.
Validation and compare-and-set updates prevent completing an upload from an unrelated state,
retrying a READY video, letting two retries win, processing a deleted video, or publishing READY
after lifecycle ownership was lost.

## Media authorization and caching

- PUBLIC videos are externally watchable only when READY and can appear on discovery surfaces once
  published. Their guarded media responses use `public, max-age=0, must-revalidate` because the
  stable URL can later become non-public.
- UNLISTED videos are externally watchable by ID when READY but never appear in public feeds/search.
  Their media responses are `private, no-store`.
- PRIVATE videos are watchable only by the owning session and use `private, no-store`.

`VideosService.assertWatchAccess` is reused for video detail, comments, likes, qualified views,
history, and media. `MediaController` authorizes the thumbnail, master manifest, allow-listed variant
manifest, and allow-listed segment on every API path before reading MinIO. Hiding a card or player in
React is not security. The current API-mediated delivery gives a simple correct authorization
boundary but spends API egress; production evolution would normally use a CDN with short-lived signed
URLs or cookies while retaining an authoritative backend access decision.

## Adaptive HLS

```text
original MP4 -> ffprobe -> source dimensions/audio
                         |
                         v
            select only non-upscaling renditions
                 360p / 480p / 720p
                 or one bounded source variant
                         |
                         v
             six-second MPEG-TS segments
                         |
                         v
            variant index.m3u8 files -> master.m3u8
```

For a 720p source, all three ladder entries are generated. A 480p source receives 360p and 480p; a
source below 360p receives one `source` variant. Renditions are encoded sequentially to avoid
oversubscribing a developer machine. H.264/AAC MPEG-TS is a compatibility-focused native Safari and
hls.js baseline. The trade-off is repeated decoding per rendition and API-mediated segment delivery.

## Why no Redux?

Most shared state in this application is remote server state, so TanStack Query already provides
cache identity, de-duplication, pagination, polling, mutation lifecycles, and invalidation. Local
interaction state belongs near the component in React. Redux would currently duplicate those
responsibilities rather than solve a demonstrated problem. I would reconsider it if the client gained
a complex cross-route editor, a large offline command model, collaborative state, or deterministic
multi-step client workflows that are not primarily server-cache state.

## Testing pyramid

```text
fast default verification
   +-- Vitest unit/component tests across packages, API, worker, and web
   +-- lint, typecheck, and production builds

service integration
   +-- NestJS + PostgreSQL + Redis integration tests
   +-- migrations, auth, social flows, outbox, and concurrent retry

browser E2E in CI
   +-- Chromium navigation, accessibility keyboard path, login, and seeded flows

explicit heavy media suites
   +-- real ffprobe/FFmpeg ABR generation and generation-2 recovery
   +-- real browser upload, MinIO assets, HLS requests, and playback progress
```

The heavy suites prove the media boundary with real binaries and services but are intentionally
separate from `pnpm verify` and the default Playwright grep. This preserves a fast routine loop and
makes the extra prerequisites explicit.

## If I had another month

I would focus on production and scale evolution, not another feature phase: put authorized media
behind a CDN, add metrics/traces and queue/media dashboards, define media-retention cleanup for
abandoned uploads and orphan objects, document backup and disaster recovery, and deploy the system
to a real environment. At larger scale I would separate transcoding capacity, introduce a richer
event pipeline and recommender, and move search only when PostgreSQL FTS stopped meeting measured
requirements. Content moderation would be required before opening uploads to untrusted users. These
are scale and product-operability improvements, not missing fundamentals for this portfolio scope.

## STAR answer: technically challenging personal project

**Situation:** I wanted a portfolio project that went beyond CRUD and made me handle the real
boundaries of uploading and playing video.

**Task:** I needed to build an end-to-end platform where large uploads, background transcoding,
authorization, concurrent retries, and an interactive frontend remained understandable and testable.

**Action:** I used direct signed uploads, a PostgreSQL transactional outbox, deterministic BullMQ
jobs, processing generations, a deletion barrier, generation-isolated HLS assets, and a focused
Next.js/TanStack Query frontend. I backed those decisions with unit, integration, browser, and real
media tests and documented their trade-offs.

**Result:** The result is a feature-complete application that can upload real MP4 files, produce and
authorize adaptive HLS, recover safely from important asynchronous races, and support the expected
video product flows. The main result for me was learning to reason about ownership and failure across
database, queue, object storage, worker, and browser boundaries without inventing exactly-once
guarantees or business metrics.

## CV bullet suggestions

- Built a production-minded video platform with Next.js, NestJS, PostgreSQL, BullMQ, MinIO, and
  FFmpeg, including direct uploads and adaptive HLS playback.
- Designed an idempotent at-least-once processing pipeline using a transactional outbox,
  deterministic jobs, processing generations, and deletion race barriers.
- Implemented a typed React/TanStack Query frontend with authorized media delivery, accessible async
  UI, PostgreSQL full-text discovery, and unit, integration, Playwright, and real-media tests.

## Six diagrams to remember

### Overall architecture

```text
Next.js UI -> NestJS API -> PostgreSQL
    |              |            |
signed PUT       media proxy   outbox
    v              v            v
  MinIO <------ worker <- BullMQ/Redis
                   |
              ffprobe/FFmpeg
```

### Upload and processing

```text
draft -> signed intent -> direct PUT -> verified completion -> outbox -> queue
      -> worker claim -> probe -> thumbnail/HLS -> asset transaction -> READY
```

### Transactional outbox

```text
[state + generation + outbox] -- one DB commit --> retrying publisher --> BullMQ
```

### Processing generations

```text
generation 1 failed -> owner retry -> generation 2
late job generation 1 != current generation 2 -> skip
```

### Frontend data flow

```text
Server route composition
        |
Client widget/feature -> query key -> API client -> NestJS DTO
        ^                                      |
        +---- cache update / invalidation <----+
```

### Video playback

```text
WatchVideo -> authorized master URL -> native HLS or dynamic hls.js
                                      -> variant manifest -> segments
timeupdate -> local accumulation -> throttled history + qualified view APIs
```

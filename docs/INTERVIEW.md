# Senior engineering interview guide

## System design

```text
                                  Browser
                       /             |              \
              Next.js application   |       direct signed PUT
                       |             |              |
                 REST + cookie       |              v
                       v             |            MinIO
                NestJS modular       |         originals + HLS
                  monolith           |              ^
              /        |       \     |              |
             v         v        v    |              |
       PostgreSQL    Redis    guarded media         |
       domain + FTS  limits       routes             |
                       |                            |
                       v                            |
                     BullMQ -- versioned job --> Worker
                                                   |
                                             ffprobe / FFmpeg
```

The API is a modular monolith. The worker is a separate runtime because transcoding has different
resource, timeout, retry, and deployment characteristics—not because every domain needs a service.

## Why these choices?

### Why a modular monolith?

Authentication, channels, videos, comments, playlists, and discovery share one consistency boundary
and one small team. Nest modules make responsibilities visible without network hops, distributed
transactions, or duplicated deployment machinery. The media worker is the one justified split.

### Why PostgreSQL?

The product is relational: one channel per owner, unique reactions/subscriptions, cascade-safe
membership, session revocation, and state transitions all benefit from transactions, foreign keys,
and unique constraints. PostgreSQL also supplies adequate full-text search at this scale.

### Why Redis and BullMQ?

Video processing cannot fit an HTTP request lifetime. BullMQ gives durable asynchronous delivery,
retries, exponential backoff, and operational separation. Delivery is at least once, so the worker
uses deterministic object keys, asset upserts, and compare-and-set status updates.

### Why MinIO?

MinIO provides an S3-compatible local environment. The API and worker code use the same object-store
semantics that a hosted S3-compatible service would provide without requiring cloud credentials for
development or interviews.

### Why direct upload?

`Browser -> MinIO` keeps large request bodies out of NestJS memory/bandwidth and avoids tying API
instances to upload duration. The API still owns authorization, creates the object key, limits the
intent lifetime, and verifies stored size/content type before enqueueing work.

### Why HLS?

Segmented delivery supports seeking, resilient playback, and browser streaming through native HLS or
hls.js.

### Why adaptive bitrate HLS?

Different viewers have different network throughput, screen sizes, and device decode capacity. A
master playlist lets hls.js or native HLS automatically move between variants, reducing buffering
without forcing every viewer to download the highest bitrate. This project deliberately stops at
360p, 480p, and 720p: that is enough to demonstrate adaptation while keeping laptop CPU, temporary
disk, and demo time bounded. Source-aware selection prevents upscaling, including for portrait and
unusual aspect ratios.

### Why worker concurrency equals one locally?

FFmpeg consumes substantial CPU and memory. One job at a time gives predictable laptops and demos.
Within a job, renditions are also sequential because each FFmpeg process already uses CPU threads;
parallel encodes can oversubscribe a developer machine. Throughput is not the bottleneck for this
workload. The setting is configurable up to a deliberately small bound, but production sizing would
be based on measured resource envelopes.

### Why TanStack Query and no Redux?

Most client state is remote server state: session, feeds, comments, playlists, and mutations. TanStack
Query supplies request ownership, staleness, infinite pages, invalidation, and optimistic rollback.
Local component state handles dialogs and forms; there is no demonstrated cross-application client
state problem that would justify Redux.

### Why PostgreSQL FTS and not Elasticsearch?

Weighted `tsvector`, `websearch_to_tsquery`, ranking, and a partial GIN index satisfy the current data
and operational scale. A separate search cluster would add synchronization and failure modes before
it adds user value.

### Why cursor pagination?

Chronological endpoints keyset on `(timestamp, id)` and ranked endpoints add a deterministic score.
Cursors avoid large offsets and remain stable when earlier rows are inserted. The home feed freezes an
`asOf` boundary; search also freezes ranking time. Mutable engagement counts can still shift ranking
between requests, which is documented rather than hidden behind a fake guarantee.

### Why polling and not WebSockets?

Only upload processing needs near-real-time feedback. A two-second query that stops at READY/FAILED is
simple, observable, and sufficient. WebSocket connection, authorization, and fan-out lifecycle would
not solve another current requirement.

### Why no microservices, Kafka, or Kubernetes?

They solve organizational and throughput constraints this project does not have. Adding them would
move interview discussion toward infrastructure ceremony instead of consistency, failure handling,
security, and product behavior that the code actually demonstrates.

## Upload and processing sequence

```text
Browser -> API: create owned video draft
API -> Browser: signed upload URL (15 minutes)
Browser -> MinIO: PUT original MP4
Browser -> API: complete upload
API -> MinIO: HEAD and verify size/content type
API -> PostgreSQL: ORIGINAL + generation 1 + outbox (short transaction)
API publisher -> Redis/BullMQ: enqueue deterministic generation job
Worker -> MinIO: download original
Worker -> ffprobe: authoritative validation
Worker -> planner: source-aware 360/480/720 selection
Worker -> FFmpeg: source thumbnail + sequential HLS renditions
Worker -> worker: write master.m3u8 with relative variants
Worker -> MinIO: upload segments, variants, master last, thumbnail
Worker -> PostgreSQL: assets + READY (short transaction)
```

## Failure and idempotency sequence

```text
temporary storage/database failure -> BullMQ retry with exponential backoff
invalid/corrupt media              -> discard retries and mark FAILED
retry budget exhausted             -> best-effort generated cleanup + FAILED
owner retry                        -> validate ORIGINAL + increment generation + outbox
old generation wakes              -> generation mismatch -> successful no-op
concurrent deletion                -> DELETING wins; completion CAS fails; cleanup prefixes
duplicate READY delivery           -> no-op
```

External processing never runs inside a database transaction. The processing outbox makes the state
claim and durable publication intent atomic; its bounded API publisher performs the non-atomic queue
write afterward and retries until marked published.

## How do you safely retry asynchronous video processing?

Treat a user retry as a new logical processing generation, not another BullMQ attempt. Generation 1
is the initial run; an accepted retry compare-and-sets FAILED, increments the generation, clears the
safe failure reason, and creates one outbox row in the same short PostgreSQL transaction. The job ID
contains video ID plus generation, making repeated publication idempotent. Ordinary BullMQ attempts
reuse the same generation.

The worker checks state and generation before FFmpeg, before upload, and in the final READY
compare-and-set. It never runs FFmpeg inside a database transaction. Generated objects use isolated
generation prefixes, only committed asset rows become authoritative, and stale/deleted work cleans
only its own prefix. The DELETING barrier prevents resurrection. Terminal failure updates FAILED only
for the current generation and exposes a curated reason while internal logs retain diagnostic detail.

### Why use an outbox here?

PostgreSQL and Redis/BullMQ cannot share an atomic commit. With `await db.update(); await queue.add()`,
a crash after the database call strands processable state without a job. Reversing the calls creates
the opposite orphan-job window. A purpose-specific PostgreSQL outbox commits state and publication
intent together. If queue publication fails it remains pending; if publishing succeeds but marking
it crashes, the deterministic BullMQ ID safely deduplicates the retry.

### Why not Kafka?

There is one asynchronous domain pipeline, BullMQ already supplies durable work delivery, retries,
and backoff, and PostgreSQL is already the source of truth. The small outbox closes the actual
dual-write gap. Kafka would add deployment, monitoring, partitioning, and consumer operations without
solving another demonstrated requirement.

## Authorization model

| Resource                     | Anonymous                  | Viewer              | Owner                                   |
| ---------------------------- | -------------------------- | ------------------- | --------------------------------------- |
| PUBLIC READY video/media     | read                       | read/interact       | read/manage                             |
| UNLISTED READY video/media   | direct URL                 | direct URL/interact | read/manage                             |
| PRIVATE video/media          | hidden                     | hidden              | read/manage                             |
| Public playlist              | read playable PUBLIC items | same                | manage if owned                         |
| Private/Watch Later playlist | hidden                     | own only            | manage items; system settings immutable |
| Comment deletion             | no                         | author only         | video owner may moderate                |

UNLISTED means absent from Home, Search, public channel listings, related recommendations, and public
playlist additions, while remaining directly accessible by URL. Every sensitive ID is rechecked
against the authenticated user server-side.

## What would change at YouTube scale?

Scale—not missing project requirements—would drive a CDN and signed edge authorization, multi-region
object storage, per-title/content-aware ladders, independent rendition jobs, specialized or hardware
encoding workers, distributed orchestration, event streaming, sharded metadata stores, dedicated
search and recommendation platforms, analytics pipelines, moderation, DRM/content protection, and
explicit disaster recovery. The bounded in-memory home ranker would likely become an offline/online
recommendation system with persisted candidate snapshots.

None of those additions improves the learning ROI of this single-developer application today.

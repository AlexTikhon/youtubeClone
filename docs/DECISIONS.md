# Decisions

## Scope-appropriate trade-offs

| Decision            | Chosen                  | Not chosen                | Why this fits the current project                                                                      |
| ------------------- | ----------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| Backend             | NestJS modular monolith | Microservices             | One deployable API keeps transactions and local operation clear while retaining module boundaries.     |
| Queue               | BullMQ                  | Kafka                     | Redis-backed jobs provide the retries and concurrency needed by one media pipeline.                    |
| Search              | PostgreSQL FTS          | Elasticsearch             | The existing database provides weighted search and indexing without another consistency boundary.      |
| Processing status   | Polling                 | WebSockets                | A bounded two-second Studio poll is adequate for a single upload workflow and stops at terminal state. |
| Client server state | TanStack Query          | Redux                     | Query caching and invalidation fit remote state; local UI state remains local.                         |
| Media delivery      | HLS                     | Custom streaming protocol | Native Safari support plus hls.js provides adaptive playback using established tooling.                |
| Storage             | S3-compatible MinIO     | Database blobs            | Object storage keeps large bytes outside transactional metadata storage.                               |
| Reliability         | Transactional outbox    | Distributed transaction   | A narrow outbox closes the PostgreSQL/BullMQ dual-write gap with low operational cost.                 |

These are workload and portfolio-scope choices, not claims that the alternatives are universally
inferior.

## Server sessions and seeded development login

Opaque server-side sessions provide revocation and keep credentials out of browser storage. Passwords
use Node's scrypt with a random salt. The project intentionally provides one seeded local account rather
than registration, OAuth, reset, or email workflows. Deployment must override the development seed
password and production secrets.

## Direct upload, proxied playback

Large incoming bytes bypass NestJS through a signed PUT. Outgoing HLS and thumbnails use authorized
API routes for a correct, simple localhost/private-video boundary. A CDN/object-store delivery layer
can replace that adapter later without changing frontend DTOs.

## Source-aware adaptive MPEG-TS HLS

MPEG-TS, H.264, and AAC provide the least surprising native-Safari/hls.js baseline. New videos receive
a source-aware 360/480/720 ladder and one master playlist; small sources receive one bounded `source`
variant. This improves playback across network and device conditions without adding 1080p, newer
codecs, DASH, or player quality UI. The existing HLS_MANIFEST JSON metadata was already sufficient,
so no migration or segment rows were added. Legacy single-rendition manifests remain playable.

Renditions use separate sequential FFmpeg processes. Decoding more than once is less efficient than a
split filter graph, but it keeps commands, timeout failures, retries, and local debugging independent.
FFmpeg itself uses multiple threads, so running variants in parallel would oversubscribe typical
developer hardware. A production platform could schedule rendition jobs independently.

## Polling instead of push

Two-second React Query polling is sufficient for one upload workflow, easy to reason about, and stops
at terminal states. WebSockets would add connection and authorization lifecycle work before there is
a broader real-time requirement.

## Transactions around invariants, not FFmpeg

Upload completion and processing completion use short transactions. Downloads and FFmpeg never run
inside a transaction. READY is written only in the same transaction that stores required generated
asset metadata, after those objects have uploaded successfully.

## Host worker plus reproducible container option

Host `pnpm dev` keeps fast reload and expects configured FFmpeg/ffprobe binaries. The optional Compose
`media` profile builds a worker image with FFmpeg for machines without those tools and for repeatable
pipeline verification. Transcode concurrency defaults to one because video jobs are CPU-heavy and
ABR multiplies temporary disk and CPU work within each job.

## Explicit failed-processing recovery

`FAILED -> PROCESSING` is allowed only through the owner retry command. The command verifies the
ORIGINAL database record and MinIO object, compare-and-sets the failed generation, increments it, and
writes a purpose-specific outbox event in one PostgreSQL transaction. `READY -> PROCESSING` remains
forbidden because this feature recovers terminal failures rather than replacing healthy published
media. BullMQ attempts remain internal retries within one generation.

The outbox exists because PostgreSQL state and Redis/BullMQ enqueueing are a dual write with no shared
transaction. A tiny periodic publisher plus deterministic generation-specific job IDs closes the
crash window. Kafka was rejected: there is one asynchronous domain pipeline, BullMQ already provides
delivery and retry behavior, and another distributed system would add more operational cost than
capability. The outbox is intentionally not generalized beyond video processing.
Published rows are retained for 30 days for recent operational inspection, then deleted by the API's
daily best-effort cleanup. Unpublished rows are never removed by retention and continue to retry.

## Publishing semantics

The first READY-to-PUBLIC transition sets `publishedAt`. Hiding a video removes it from publication;
republishing retains its original timestamp so visibility toggles cannot game feed recency.

## PostgreSQL social state and qualified views

Likes, comments, subscriptions, views, and history stay in PostgreSQL. Composite keys enforce reaction
and subscription uniqueness; aggregate counts use `_count` or deliberate count queries. Redis counters
would add reconciliation complexity without demonstrated need.

Only authenticated viewers count. The threshold is `min(10 seconds, 50% of duration)` and a
unique UTC-day bucket resists concurrent duplicates. Anonymous playback remains supported without
fingerprinting. Distributed rate limiting and rolling view windows are production follow-ups.

## Synchronous retryable deletion

The local deployment performs storage cleanup synchronously behind `DELETING` instead of adding a
second queue. Cleanup is idempotent and retryable. Worker checks before upload and at commit, with
generated-prefix cleanup after a lost completion claim. A failed request can leave a pending-deletion
row, which is safer than exposing a READY row whose media was partially removed.

## PostgreSQL search instead of a search service

The current scale does not justify Elasticsearch-class infrastructure. A database trigger builds a
weighted English `tsvector` from video title (A), channel name/handle (B), and description (C), and a
partial GIN index covers only READY/PUBLIC videos. `websearch_to_tsquery` provides useful user query
semantics. Text rank is multiplied so capped popularity and recency remain tie-breakers rather than
turning search into the Home feed.

Search rank is rounded to six decimal places and the opaque cursor stores rank, publication time,
ID, and the ranking `asOf` time. This prevents time-based recency drift between pages. View-count
changes can still move an item between requests; immutable search snapshots are deliberately out of
scope.

## Playlists and Watch Later

Watch Later is a `Playlist` with explicit `WATCH_LATER` type, not a magic title or separate table.
A partial unique index guarantees at most one per owner. It is fixed, PRIVATE, and cannot be edited
or deleted; a SQL CHECK backs the PRIVATE invariant. Playlist items use `(playlistId, videoId)`
identity and a unique explicit position. A transaction-scoped advisory lock serializes position
allocation for a playlist. The 200-item bound keeps
detail reads and ordering operations predictable without premature reorder UI.

## Cache and abuse policy

No Redis DTO cache was added. The likely read models have broad invalidation requirements and the
local workload does not demonstrate a latency need. Redis does enforce small distributed
fixed-window limits on login, comments, qualified-view writes, and public search; media routes are
excluded. Likes have a higher authenticated-user limit because the write is idempotent but still
causes an aggregate count query. Public VOD segments, completed manifests, and thumbnails are
immutable and receive long-lived HTTP cache headers. PRIVATE/UNLISTED bytes are never publicly cached.

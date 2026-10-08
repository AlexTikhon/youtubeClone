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
than registration, OAuth, reset, or email workflows. Development/test login builds may prefill and
describe that account; production builds render empty credential fields without seeded-account help.
Production seeding requires an explicit `DEV_SEED_PASSWORD`, while the weak documented fallback is
limited to development/test. Deployment must also provide its normal production secrets.

## Direct upload, proxied playback

Large incoming bytes bypass NestJS through a presigned **POST policy**. Outgoing HLS and thumbnails use
authorized API routes for a correct, simple localhost/private-video boundary. A CDN/object-store
delivery layer can replace that adapter later without changing frontend DTOs.

A presigned PUT was rejected for uploads: it cannot carry a size limit, so `MAX_UPLOAD_SIZE_BYTES`
would only validate the _client-declared_ size while storage accepted any number of bytes, and the
mismatch would be discovered only after storage had taken them. A POST policy lets object storage
itself enforce the exact key, the exact content type, and a `content-length-range` bound to the upload
intent, still with direct browser-to-storage transfer, progress events, and cancellation. The range is
exact (declared size, declared size) because completion already requires an exact match, which
rejects a mismatch earlier and at no extra cost. The declared size is capped by the configurable limit
both when the intent is created and when a pending intent is re-signed. The cost is a multipart
form in the browser (signed fields first, file last) instead of a raw body; MinIO and S3 both
implement the policy conditions, which `apps/api/test/upload-admission.integration.test.ts` verifies
against real MinIO.

## Idempotent upload completion

Completion may succeed on the server while its response is lost, and a retry must not require
re-uploading or fail with a state conflict. Replaying completion for an upload whose record is
`COMPLETED` returns the video's current lifecycle state (`UPLOADED`, `PROCESSING`, `READY`, or
`FAILED`) with `alreadyCompleted: true`. Requiring the upload record to be `COMPLETED` keeps unrelated
states (a draft, a deleting video, a failed video whose upload never finished) rejected. Concurrent
first calls race on the `UPLOADING -> UPLOADED` compare-and-set and the loser reports the winner's
state, so one asset and one outbox event exist without extra locking. The client treats a network
error or 5xx as _uncertain_ and consults the owner's view of the video before retrying only the step
that is actually missing.

## Attempt ownership instead of job-ID fencing

Generation fencing and a deterministic BullMQ job ID cannot distinguish two overlapping executions of
the same generation, and raising the lock duration or worker concurrency only narrows the window.
Ownership is a PostgreSQL concern, so each execution acquires an _attempt_ with a renewable lease on
the video row: atomic acquisition or takeover, conditional renewal, and READY/FAILED transitions fenced
by generation and attempt ID. Output lives under a unique per-attempt prefix, and the winning attempt
is recorded (`committedAttemptId`, `VideoAsset.attemptId`) so media selection is explicit. A lease in
the video row keeps the design inside the existing modular monolith: no lock service, no workflow
framework, and transactions stay short because FFmpeg and uploads never run inside one. The lease uses
the database clock and a heartbeat, and stops renewing after a hard ceiling so a wedged attempt is
recoverable. The cost is a heartbeat per active attempt and four nullable columns; the benefit is that
a slow or partitioned worker is merely a loser, never a corrupting writer.

## Reconciliation of stranded generations

The outbox closes the PostgreSQL-to-Redis dual write only until an event is marked published; Redis can
then lose the job, and BullMQ can fail one outside the worker's error handling. Rather than a generic
scheduler, a small reconciler inspects only published events whose generation is still pending and has
no valid lease, claims each with an atomic timestamp (multi-instance safe), and applies idempotent
conditional writes: re-publish a missing job after revoking the expired owner, or move to FAILED so the
existing owner Retry works. Scans, inspections, and re-publications are bounded, and retention never
removes evidence for unfinished generations. It is a backstop; the worker records terminal BullMQ
failures itself when it can.

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
media. BullMQ attempts remain internal retries within one generation, each owning the generation through a lease.

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

Only authenticated viewers count. The threshold is
`min(10 seconds, max(1 second, 50% of duration))`, and a unique UTC-day bucket resists concurrent
duplicates. Anonymous playback remains supported without
fingerprinting. Distributed rate limiting and rolling view windows are production follow-ups.

## Synchronous retryable deletion

The local deployment performs storage cleanup synchronously behind `DELETING` instead of adding a
second queue. Cleanup is idempotent and retryable. Worker ownership checks run before upload and at commit, with
that attempt's own prefix cleaned after a lost completion claim. `DeleteObjects` per-key errors count as a
failed cleanup even when the S3 request itself succeeded. A failed request can leave a pending-deletion
row, which is safer than deleting database authority while media remains.

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
causes an aggregate count query. Generated VOD bytes are immutable, but their stable guarded URLs can
change from PUBLIC to PRIVATE/UNLISTED. PUBLIC responses therefore use
`public, max-age=0, must-revalidate`; PRIVATE/UNLISTED responses use `private, no-store`. CDN-scale
delivery would instead need versioned or signed URLs and explicit invalidation or authorization tokens.

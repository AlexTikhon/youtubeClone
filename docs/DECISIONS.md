# Decisions

## Server sessions and seeded development login

Opaque server-side sessions provide revocation and keep credentials out of browser storage. Passwords
use Node's scrypt with a random salt. Phase 1 intentionally provides one seeded local account rather
than registration, OAuth, reset, or email workflows. Deployment must override the development seed
password and production secrets.

## Direct upload, proxied playback

Large incoming bytes bypass NestJS through a signed PUT. Outgoing HLS and thumbnails use authorized
API routes for a correct, simple localhost/private-video boundary. A CDN/object-store delivery layer
can replace that adapter later without changing frontend DTOs.

## MPEG-TS HLS and one bounded rendition

MPEG-TS, H.264, and AAC provide the least surprising native-Safari/hls.js baseline. One rendition
bounded to 720p controls local processing cost. Rendition metadata is an array even though Phase 1
emits one entry, allowing Phase 2 to add an adaptive master playlist without segment database rows.

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
pipeline verification. Transcode concurrency defaults to one because video jobs are CPU-heavy.

## No implicit reprocessing

`READY -> PROCESSING` and `FAILED -> PROCESSING` were removed because no safe user-facing reprocess
workflow existed. BullMQ retries remain internal to the original job. A future retry feature must first
validate the original object and establish a new idempotent job lifecycle.

## Publishing semantics

The first READY-to-PUBLIC transition sets `publishedAt`. Hiding a video removes it from publication;
republishing retains its original timestamp so visibility toggles cannot game feed recency.

## PostgreSQL social state and qualified views

Likes, comments, subscriptions, views, and history stay in PostgreSQL. Composite keys enforce reaction
and subscription uniqueness; aggregate counts use `_count` or deliberate count queries. Redis counters
would add reconciliation complexity without demonstrated need.

Only authenticated viewers count in Phase 2. The threshold is `min(10 seconds, 50% of duration)` and a
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
and ID. This makes page order deterministic for a stable database state. View-count changes can move
an item between requests; immutable search snapshots are deliberately out of scope.

## Playlists and Watch Later

Watch Later is a `Playlist` with explicit `WATCH_LATER` type, not a magic title or separate table.
A partial unique index guarantees at most one per owner. It is fixed, PRIVATE, and cannot be edited
or deleted. Playlist items use `(playlistId, videoId)` identity and a unique explicit position. An
advisory transaction lock serializes position allocation for a playlist. The 200-item bound keeps
detail reads and ordering operations predictable without premature reorder UI.

## Cache and abuse policy

No Redis DTO cache was added. The likely read models have broad invalidation requirements and the
local workload does not demonstrate a latency need. Redis does enforce small distributed
fixed-window limits on login, comments, qualified-view writes, and public search; media routes are
excluded. Public VOD segments and thumbnails are immutable and receive long-lived HTTP cache
headers, manifests receive a short public TTL, and PRIVATE/UNLISTED bytes are never publicly cached.

# Architecture

## Runtime boundaries

```text
Next.js web --REST + HTTP-only cookie--> NestJS API --> PostgreSQL
     |                                      |
     +----------- signed PUT ------------> MinIO
                                            ^
API -- versioned job --> Redis/BullMQ --> worker -- ffprobe/FFmpeg
                                            |
                                            +--> MinIO thumbnail + HLS
```

```text
                         Next.js
                            |
        Home -- Search -- Watch -- Playlists -- Studio
                            |
                         NestJS API
                 /          |          \
          PostgreSQL      Redis        MinIO
          domain + FTS   queue/limits   media
                            |
                          worker
                    ffprobe / FFmpeg
```

The API remains a modular monolith. Media processing is a separate deployment because its CPU,
memory, timeout, and retry characteristics differ from request handling. PostgreSQL is authoritative
for users, sessions, video state, upload intents, and asset metadata. Redis carries disposable queue
state; MinIO carries all media bytes.

The worker has lifecycle-managed database, storage, and media-tool services. It never holds a
database transaction while downloading media or running FFmpeg. The API and worker share only real
cross-boundary contracts: video states and the versioned job payload.

## Authentication and authorization

Login creates a cryptographically random opaque token. Only its SHA-256 hash is stored in
`AuthSession`; the browser receives the token in an `HttpOnly`, `SameSite=Lax`, path-wide cookie that
is `Secure` in production and has an explicit lifetime. Every authenticated request validates the
server-side session and expiry. Logout revokes the record and clears the cookie.

Video creation derives the channel from `authenticatedUser.channel`; a browser never supplies an
ownership-sensitive channel ID. Owned DRAFT through FAILED videos are visible to their owner.
PUBLIC and UNLISTED videos are externally watchable only at READY. Only PUBLIC, READY videos with a
`publishedAt` value appear on the home page. PRIVATE media routes require the owner session.

## HTTP and media delivery

API responses use deliberate DTOs and ISO dates; Prisma rows, BigInts, storage keys, and session
internals do not cross the HTTP boundary. Browser upload bytes go directly to the signed MinIO URL.

Playback and thumbnail URLs point to guarded API media routes rather than MinIO. This avoids leaking
internal object keys/endpoints, works across host and Docker DNS, and lets every relative HLS segment
request use the same visibility policy. It adds API bandwidth, which is acceptable for this home
phase; a production CDN with signed cookies/URLs is a later optimization.

## Client structure

React Query owns session, collection, and video server state. Processing polling runs every two
seconds and stops at READY or FAILED. XHR is isolated behind `shared/upload/upload-file.ts`, exposing
progress and AbortSignal cancellation. The player uses native HLS where available and an isolated
hls.js instance elsewhere, destroying it on cleanup.

The client keeps URL search state in `/search?q=...`, isolates Save/playlist behavior from the player,
and preserves playlist playback with `?list=<playlistId>`. Route shells remain server components;
interactive query/mutation boundaries are focused client components. A small query-key factory is
used for the cross-feature invalidations introduced by playlists and search.

## Read models and pagination

Public cards, watch details, and creator rows are separate DTOs. Public cards never contain failure or
processing internals; Studio rows do. The watch endpoint composes channel and engagement state in one
bounded read model, while comments remain independently paginated.

Chronological collections use opaque `(timestamp, id)` keyset cursors. Home ranks a bounded union of
recent, popular, and subscribed candidates, freezes an `asOf` boundary, and keysets on
`(score, publishedAt, id)`. It never loads the full table. Concurrent count changes can move an item
between pages; a persisted immutable ranking snapshot is deferred until scale justifies that storage.
The candidate windows are intentionally capped (150 recent, 75 popular, 75 subscribed), so the feed
ends when that union is exhausted even if older database rows exist. This is a bounded home ranker,
not an infinite recommendation archive.

## Social and watch domain

`VideoLike` and `Subscription` use composite primary keys, making PUT idempotent; repeated DELETE uses
`deleteMany`. Counts remain PostgreSQL aggregates. The centralized watch-access check gates watch DTOs,
comments, likes, qualified views, history writes, and media bytes.

A view requires authenticated forward playback of `min(10 seconds, 50% of duration)` and is unique per
user/video/UTC day. `WatchHistory` separately stores the latest position. The browser writes at most
about every 12 seconds and on pause/end. Resume applies only above five seconds and more than ten
seconds from completion. The HLS player only emits callbacks and has no persistence knowledge.

## Creator deletion lifecycle

Deletion compare-and-sets `DELETING`, immediately blocking playback and worker completion. Object
cleanup runs outside database transactions and is idempotent; only success cascade-deletes the row.
Failure leaves `DELETING` for an owner retry. If a worker uploads after deletion begins, its final state
claim fails, its asset transaction rolls back, and it removes generated prefixes. This prevents both
database resurrection and normal-operation storage leaks.

## Discovery and playlists

PostgreSQL owns a trigger-maintained weighted video `tsvector`. A partial GIN index contains only
READY/PUBLIC rows. Search ranks text first, then bounded popularity and recency signals, and keysets
on rounded `(rank, publishedAt, id)` while freezing ranking time in an `asOf` cursor field. Related
videos use same-channel, title-token, popularity, and recency signals and return at most 20
database-ranked rows.

`Playlist` and `PlaylistItem` are a small explicit domain. Composite keys prevent duplicate videos,
positions define order, foreign-key cascades remove only membership rows, and a partial unique index
allows one `WATCH_LATER` system playlist per user. A database CHECK also keeps it PRIVATE. Creation
recovers from unique-conflict races, while a transaction-scoped PostgreSQL advisory lock serializes
`MAX(position) + 1` allocation without distributed locking. Public playlist reads still include only
playable PUBLIC videos. Owner checks happen in the service before every mutation.

Redis remains queue infrastructure plus a narrow fixed-window rate-limit boundary for login,
comments, likes, view qualification, and search. DTO/read-model caching is intentionally absent because
visibility and metadata invalidation spans feeds, search, related results, and playlists. Public
immutable thumbnails/HLS segments use HTTP caching; non-public media is `private, no-store`.

## CSRF and proxy assumptions

Authentication is cookie-based. Browser mutations use JSON or non-simple HTTP methods, exact-origin
CORS allows credentials only from `WEB_URL`, and the session cookie is `SameSite=Lax` (`Secure` in
production). Together these are sufficient for the current same-site web/API deployment. If the API
is later exposed to untrusted same-site sibling origins, add explicit Origin validation or a CSRF
token before that deployment.

Rate limits are Redis-backed and fail open if Redis is unavailable so an infrastructure incident does
not take down the API. Media routes are intentionally excluded. `request.ip` is the anonymous key;
a reverse-proxy deployment must configure trusted proxy handling at the edge before treating those
limits as per-client guarantees.

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

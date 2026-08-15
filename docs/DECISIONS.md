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

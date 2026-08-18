# Video pipeline

## Lifecycle

```text
DRAFT -> UPLOADING -> UPLOADED -> PROCESSING -> READY
            |             |            |
            +-----------> FAILED <------+
                              |
                              +-- owner retry --> PROCESSING (new generation)
```

The API records an upload intent before issuing a 15-minute signed PUT URL. Completion checks video
ownership, expected state/upload record, object existence, non-zero and expected byte length, and
the intended `video/mp4` content type. It then transactionally creates the ORIGINAL asset and moves
the video to UPLOADED, assigns processing generation 1, and writes a processing outbox row in the
same transaction. A lightweight API publisher later enqueues the versioned BullMQ job.

Because the signed PUT remains usable until its 15-minute expiry, the worker compares the object's
current content length with the API-verified ORIGINAL record before downloading it. A changed length
is treated as invalid input; the downloaded bytes are still validated authoritatively by ffprobe.
A same-length owner replacement during that short URL lifetime cannot be distinguished without an
object version or client-provided digest. The random per-video object key limits the capability to
that upload, and ffprobe remains authoritative, but immutable promotion or checksums would be the
production hardening step.

The worker claims UPLOADED as PROCESSING through the shared domain transition rules, then works in a
unique `mkdtemp` directory:

```text
MinIO ORIGINAL -> local original -> ffprobe
                                  +-> thumbnail.jpg
                                  +-> select source-aware ladder
                                      +-> hls/360p/index.m3u8 + segments
                                      +-> hls/480p/index.m3u8 + segments
                                      +-> hls/720p/index.m3u8 + segments
                                  +-> hls/master.m3u8
                                  -> upload generated assets
                                  -> short metadata/assets/READY transaction
                                  -> remove temporary directory in finally
```

ffprobe must report a positive duration and a usable video stream. Stored metadata includes source
display dimensions, rotation, container, codecs, frame rate, and bitrate when available. FFmpeg
auto-rotation handles phone display metadata; the planner uses the corresponding swapped dimensions,
so portrait media remains portrait. The JPEG thumbnail still comes from the original.

The pure rendition planner selects target heights at 360, 480, and 720 only when the source is at
least that tall. It preserves aspect ratio, rounds to even H.264 dimensions, and never upscales. A
source below 360p receives one `source` rendition bounded to its original dimensions. The static
ladder uses approximately 800/96 kbps, 1400/128 kbps, and 2800/128 kbps video/audio rates. Audio is
AAC when present; an audio-less source remains valid and produces video-only variants.

Each rendition uses a separate sequential FFmpeg process with `libx264`, the `veryfast` preset,
`yuv420p`, and MPEG-TS HLS. Six-second forced keyframes, scene-cut suppression, the same six-second
HLS target, and independent-segment flags approximate aligned switching boundaries without changing
source frame rate. Sequential encoding is deliberate: FFmpeg is already multithreaded, and parallel
encoders would make laptop CPU and memory use unpredictable. Every required encode must succeed
before the master is created.

The generated master uses relative variant paths. `BANDWIDTH` is `(video kbps + audio kbps) + 10%`
for estimated MPEG-TS/container overhead; audio is excluded when absent. `CODECS` is intentionally
omitted because this fixed `libx264` setup does not currently derive an accurate RFC 6381 profile and
level string from each output.

## Object layout

```text
video-originals/originals/{videoId}/{randomObjectId}.mp4
video-thumbnails/videos/{videoId}/generations/{generation}/thumbnail/thumbnail.jpg
video-streams/videos/{videoId}/generations/{generation}/hls/master.m3u8
video-streams/videos/{videoId}/generations/{generation}/hls/360p/index.m3u8
video-streams/videos/{videoId}/generations/{generation}/hls/360p/segment000.ts
video-streams/videos/{videoId}/generations/{generation}/hls/480p/index.m3u8
video-streams/videos/{videoId}/generations/{generation}/hls/720p/index.m3u8
```

Generated paths are deterministic within an isolated logical generation. Each variant's segments
upload before its playlist; the master uploads last. Segments remain only in object storage.
PostgreSQL stores ORIGINAL, THUMBNAIL, and one
HLS_MANIFEST row whose object key is `master.m3u8` and whose JSON metadata describes every rendition.
The successful transaction creates the authoritative THUMBNAIL and HLS_MANIFEST rows. Guarded media
routes resolve those records, so stable public URLs never expose storage keys and never select an
unsuccessful generation. Existing legacy `hls/...` records remain readable.

## Retries, idempotency, and failure

BullMQ uses three attempts with exponential backoff and a deterministic
`video-{videoId}-generation-{generation}` job ID.
This is at-least-once execution, not distributed exactly-once processing. Retries reuse deterministic
generation keys, clear that generation's partial prefix before upload, and upsert asset rows. READY
delivery is a no-op. Network/storage/database failures are
retryable; invalid probe output, unavailable media executables, and deterministic FFmpeg failures
are non-retryable. The video moves to FAILED only for a non-retryable error or after retry exhaustion.
Terminal failure makes a best-effort removal of generated thumbnail/HLS objects and stores a safe
failure reason. Failure of one required rendition fails the entire attempt; no partial ladder is
marked READY. Every attempt removes its unique local working directory, including all rendition
directories and the master, in `finally`.

## Processing generations and the transactional outbox

```text
FAILED generation=1
       |
       | owner Retry
       v
PROCESSING generation=2 -- same PostgreSQL transaction --> outbox row
                                                    |
                                                    v
                                      periodic publisher --> BullMQ --> worker
                                                                  /          \
                                                               READY        FAILED
```

BullMQ attempts are infrastructure retries inside one logical generation. Three Bull attempts for
generation 2 do not increment the generation; an owner retry after terminal failure creates
generation 3. The retry endpoint is owner-only and accepts only FAILED. Before its short compare-and-set
transaction it verifies exactly one ORIGINAL asset, valid size/content-type metadata, and the actual
MinIO object. Two concurrent retry requests both observe FAILED at most briefly, but only one
`WHERE status = FAILED AND processingGeneration = oldGeneration` update can win. The unique
`(videoId, generation)` outbox constraint is a second guard.

```text
PostgreSQL transaction
   +-- processing state and generation
   +-- purpose-specific outbox event
   COMMIT
      |
      v
publisher -- deterministic add --> BullMQ
```

`await db.update(); await queue.add()` is a dual write: a process crash between the two calls leaves
durable state with no job. PostgreSQL cannot atomically commit a Redis write. The outbox closes that
gap: publication failure leaves `publishedAt = NULL`, so the current or a restarted API retries it.
If publication succeeds but marking the row crashes, the deterministic BullMQ ID makes republishing
idempotent. This is deliberately one table and one bounded periodic publisher for the only durable
asynchronous domain pipeline; it is not a generic event bus.

Published outbox rows remain available for 30 days, then a daily best-effort task deletes them.
Unpublished rows are excluded from cleanup, so retention cannot discard work that still needs to be
queued.

```text
stale job generation=1
          |
          v
DB processingGeneration=2
          |
          v
SKIP successfully
```

The worker checks generation and state before expensive work, before generated upload, and before
the final READY transaction. The final update also compare-and-sets PROCESSING plus the generation.
A stale job or stale terminal failure therefore cannot change the newer run. Lost ownership triggers
best-effort cleanup of only that job's generation. A successful run best-effort removes older
generation prefixes but never the ORIGINAL.

Visibility may change while FFmpeg is running. Processing completion first compare-and-sets READY,
then conditionally initializes `publishedAt` from the current database visibility. The API's publish
path performs the complementary check, so either ordering of the race leaves READY/PUBLIC published.

The worker checks PROCESSING before generated upload and again through the final compare-and-set. If
DELETING wins, that generated generation prefix is removed and READY is never published. Upload
intents are capped at 2 GiB by default, the worker rejects media longer than two hours before
encoding, and each
media subprocess retains its 15-minute timeout. These are laptop-oriented guardrails.

## Worker health

The worker exposes `GET /health/live` and `GET /health/ready` on port 4001 by default. Liveness only
means the process and its tiny health server are alive; it must not restart a process merely because
a dependency is temporarily unavailable. Readiness checks PostgreSQL, the BullMQ/Redis connection,
all required MinIO buckets, FFmpeg, and ffprobe because each is required to accept work. API readiness
continues to check only its synchronous PostgreSQL and Redis dependencies and does not depend on
worker-local FFmpeg.

## Real media verification

```powershell
docker compose --profile media up -d --build worker
docker compose exec worker pnpm --filter @youtube-clone/worker test:integration
$env:RUN_MEDIA_E2E='true'; pnpm test:e2e:media
```

The media integration suite generates 720p and 360p sources, validates the real master, variants,
segments, audio-less behavior, and FFprobe playback, and drives a FAILED generation 1 through a real
generation-2 pipeline to READY with isolated authoritative assets. The browser test generates a
two-second 720p MP4, uploads it through the signed URL, waits for READY, verifies all three master
variants, plays it,
deletes the video, and removes the fixture. No media binary is committed to the repository.

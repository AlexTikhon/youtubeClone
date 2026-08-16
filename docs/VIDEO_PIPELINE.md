# Video pipeline

## Lifecycle

```text
DRAFT -> UPLOADING -> UPLOADED -> PROCESSING -> READY
            |             |            |
            +-----------> FAILED <------+
```

The API records an upload intent before issuing a 15-minute signed PUT URL. Completion checks video
ownership, expected state/upload record, object existence, non-zero and expected byte length, and
the intended `video/mp4` content type. It then transactionally creates the ORIGINAL asset and moves
the video to UPLOADED before enqueueing a versioned BullMQ job.

Because the signed PUT remains usable until its 15-minute expiry, the worker compares the object's
current content length with the API-verified ORIGINAL record before downloading it. A changed length
is treated as invalid input; the downloaded bytes are still validated authoritatively by ffprobe.

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
video-originals/originals/{videoId}/{uploadId}.mp4
video-thumbnails/videos/{videoId}/thumbnail/thumbnail.jpg
video-streams/videos/{videoId}/hls/master.m3u8
video-streams/videos/{videoId}/hls/360p/index.m3u8
video-streams/videos/{videoId}/hls/360p/segment000.ts
video-streams/videos/{videoId}/hls/480p/index.m3u8
video-streams/videos/{videoId}/hls/720p/index.m3u8
video-streams/videos/{videoId}/hls/720p/segment000.ts
```

Generated paths are deterministic. Each variant's segments upload before its playlist; the master
uploads last. Segments remain only in object storage. PostgreSQL stores ORIGINAL, THUMBNAIL, and one
HLS_MANIFEST row whose object key is `master.m3u8` and whose JSON metadata describes every rendition.
No schema change or segment table was needed. Existing HLS_MANIFEST rows still resolve to their
legacy `720p/index.m3u8`; only newly processed videos use the master.

## Retries, idempotency, and failure

BullMQ uses three attempts with exponential backoff and a deterministic `video-{videoId}` job ID.
This is at-least-once execution, not distributed exactly-once processing. Retries reuse deterministic
keys, clears any partial generated prefix before upload, and upserts asset rows. READY delivery is a
no-op. Network/storage/database failures are
retryable; invalid probe output, unavailable media executables, and deterministic FFmpeg failures
are non-retryable. The video moves to FAILED only for a non-retryable error or after retry exhaustion.
Terminal failure makes a best-effort removal of generated thumbnail/HLS objects and stores a safe
failure reason. Failure of one required rendition fails the entire attempt; no partial ladder is
marked READY. Every attempt removes its unique local working directory, including all rendition
directories and the master, in `finally`.

The database and queue are not one atomic resource: a crash after the upload transaction and before
enqueue can leave UPLOADED work. Repeating upload completion safely attempts the deterministic
enqueue again. A transactional outbox is intentionally deferred until operational evidence warrants
it.

Visibility may change while FFmpeg is running. Processing completion first compare-and-sets READY,
then conditionally initializes `publishedAt` from the current database visibility. The API's publish
path performs the complementary check, so either ordering of the race leaves READY/PUBLIC published.

The worker checks PROCESSING before generated upload and again through the final compare-and-set. If
DELETING wins, the generated video prefix is removed and READY is never published. Upload intents are
capped at 2 GiB by default, the worker rejects media longer than two hours before encoding, and each
media subprocess retains its 15-minute timeout. These are laptop-oriented guardrails.

## Real media verification

```powershell
docker compose --profile media up -d --build worker
docker compose exec worker pnpm --filter @youtube-clone/worker test:integration
$env:RUN_MEDIA_E2E='true'; pnpm test:e2e:media
```

The media integration suite generates 720p and 360p sources and validates the real master, variants,
segments, audio-less behavior, and FFprobe playback. The browser test generates a two-second 720p
MP4, uploads it through the signed URL, waits for READY, verifies all three master variants, plays it,
deletes the video, and removes the fixture. No media binary is committed to the repository.

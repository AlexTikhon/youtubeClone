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

The worker claims UPLOADED as PROCESSING through the shared domain transition rules, then works in a
unique `mkdtemp` directory:

```text
MinIO ORIGINAL -> local original -> ffprobe
                                  +-> thumbnail.jpg
                                  +-> hls/720p/index.m3u8 + segmentNNN.ts
                                  -> upload generated assets
                                  -> short metadata/assets/READY transaction
                                  -> remove temporary directory in finally
```

ffprobe must report a positive duration and a usable video stream. Stored metadata includes source
dimensions, container, codecs, frame rate, and bitrate when available. FFmpeg creates a JPEG frame
near 10% of the duration and one H.264/AAC MPEG-TS HLS rendition bounded to 1280x720 without
upscaling. Single rendition keeps Phase 1 reliable; the manifest's JSON metadata contains a
renditions array and storage prefix so more renditions do not require segment rows or a model
redesign.

## Object layout

```text
video-originals/originals/{videoId}/{uploadId}.mp4
video-thumbnails/videos/{videoId}/thumbnail/thumbnail.jpg
video-streams/videos/{videoId}/hls/720p/index.m3u8
video-streams/videos/{videoId}/hls/720p/segment000.ts
```

Generated paths are deterministic. Segments upload before the manifest, so a newly exposed manifest
does not reference absent objects. Segments remain only in object storage; PostgreSQL stores the
ORIGINAL, THUMBNAIL, and HLS_MANIFEST records and rendition metadata.

## Retries, idempotency, and failure

BullMQ uses three attempts with exponential backoff and a deterministic `video-{videoId}` job ID.
This is at-least-once execution, not distributed exactly-once processing. Retries reuse deterministic
keys and upsert asset rows. READY delivery is a no-op. Network/storage/database failures are
retryable; invalid probe output, unavailable media executables, and deterministic FFmpeg failures
are non-retryable. The video moves to FAILED only for a non-retryable error or after retry exhaustion.
Terminal failure makes a best-effort removal of generated thumbnail/HLS objects and stores a safe
failure reason. Every attempt removes its local working directory in `finally`.

The database and queue are not one atomic resource: a crash after the upload transaction and before
enqueue can leave UPLOADED work. Repeating upload completion safely attempts the deterministic
enqueue again. A transactional outbox is intentionally deferred until operational evidence warrants
it.

# Video pipeline

## Lifecycle

```text
DRAFT -> UPLOADING -> UPLOADED -> PROCESSING -> READY
            |             |            |
            +-----------> FAILED <------+
                              |
                              +-- owner retry --> PROCESSING (new generation)
```

The API records an upload intent (key, content type, and declared size) before issuing a 15-minute
**presigned POST policy**. A presigned PUT URL cannot carry a size limit, so storage would accept any
number of bytes; the POST policy instead pins the bucket, the exact object key, the exact
`Content-Type`, and a `content-length-range` equal to the declared size, and MinIO/S3 enforce those
conditions before accepting the object. `MAX_UPLOAD_SIZE_BYTES` still bounds the _declared_ size when
the intent is created (and again when a pending intent is re-signed), so the largest object storage
can ever admit is the configured limit. The bucket stays private; the policy grants nothing but that
one upload. The browser sends a multipart form (signed fields first, the file last) directly to
storage; the NestJS API never buffers video bytes.

Completion checks video ownership, expected state/upload record, object existence, non-zero and
expected byte length, and the intended `video/mp4` content type; these checks remain as defense in
depth even though storage already rejects mismatched uploads. It then transactionally creates the
ORIGINAL asset and moves the video to UPLOADED, assigns processing generation 1, and writes a
processing outbox row in the same transaction. A genuinely missing uploaded object remains a 409
conflict; object-storage unavailability returns 503 and does not instruct the user to upload again. A
lightweight API publisher later enqueues the versioned BullMQ job.

Completion is **idempotent**. Replaying it for an upload that was already accepted returns the
video's current lifecycle state (`UPLOADED`, `PROCESSING`, `READY`, or `FAILED`, the generation, and
`alreadyCompleted: true`) instead of a conflict, because the client may only have lost the first
response. A replay requires the upload record itself to be `COMPLETED`, so unrelated states (a
deleting video, a draft, a failed video whose upload never finished) are still rejected. Concurrent
first calls race on the `UPLOADING -> UPLOADED` compare-and-set; the loser re-reads and reports the
winner's accepted state, so exactly one ORIGINAL asset and one generation outbox event exist.

The POST policy remains valid until its 15-minute expiry, so the owner could in principle replace the
object after completion. The worker therefore compares the object's current content length with the
API-verified ORIGINAL record before downloading it. A changed length is treated as invalid input; the
downloaded bytes are still validated authoritatively by ffprobe. A same-length owner replacement
during that short window cannot be distinguished without an object version or client-provided digest.
The random per-video object key limits the capability to that upload, and ffprobe remains
authoritative, but immutable promotion or checksums would be the production hardening step.

The worker acquires the generation with an **attempt lease** (see below), which also moves UPLOADED to
PROCESSING through the shared domain transition rules, then works in a unique `mkdtemp` directory:

```text
MinIO ORIGINAL -> local original -> ffprobe
                                  +-> thumbnail.jpg
                                  +-> select source-aware ladder
                                      +-> hls/360p/index.m3u8 + segments
                                      +-> hls/480p/index.m3u8 + segments
                                      +-> hls/720p/index.m3u8 + segments
                                  +-> hls/master.m3u8
                                  -> verify lease, upload generated assets
                                  -> verify lease, short fenced metadata/assets/READY transaction
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
video-thumbnails/videos/{videoId}/generations/{generation}/attempts/{attemptId}/thumbnail/thumbnail.jpg
video-streams/videos/{videoId}/generations/{generation}/attempts/{attemptId}/hls/master.m3u8
video-streams/videos/{videoId}/generations/{generation}/attempts/{attemptId}/hls/360p/index.m3u8
video-streams/videos/{videoId}/generations/{generation}/attempts/{attemptId}/hls/360p/segment000.ts
video-streams/videos/{videoId}/generations/{generation}/attempts/{attemptId}/hls/480p/index.m3u8
video-streams/videos/{videoId}/generations/{generation}/attempts/{attemptId}/hls/720p/index.m3u8
```

Every worker _attempt_ writes under its own unique `attempts/{attemptId}/` prefix, so overlapping
executions of one generation never share a key. Each variant's segments upload before its playlist;
the master uploads last. Segments remain only in object storage. PostgreSQL stores ORIGINAL,
THUMBNAIL, and one HLS_MANIFEST row whose object key is `master.m3u8` and whose JSON metadata
describes every rendition. The READY transaction creates the authoritative THUMBNAIL and HLS_MANIFEST
rows tagged with `VideoAsset.attemptId`, records `Video.committedAttemptId`, and deletes any other
generated rows. Guarded media routes resolve only the committed attempt's rows, so stable public URLs
never expose storage keys and never select an unsuccessful or losing attempt. Legacy videos
(`committedAttemptId` and asset `attemptId` both null, keys under `generations/{n}/hls/` or `hls/`)
remain readable.

## Retries, attempt ownership, and failure

BullMQ uses three attempts with exponential backoff and a deterministic
`video-{videoId}-generation-{generation}` job ID. This is at-least-once delivery, not distributed
exactly-once processing, and a job ID alone cannot prevent two executions of one generation from
overlapping (a stalled job is redelivered while its first worker is merely slow, or two workers pick
up a retried job). Ownership is therefore enforced in PostgreSQL:

- **Attempt identity and lease.** `Video.processingAttemptId` and `processingLeaseExpiresAt` record
  the one attempt that owns the generation. Acquisition is one atomic `UPDATE` that succeeds only
  when no attempt owns the generation or the owner's lease expired (a takeover). All lease arithmetic
  uses the database clock, so skewed worker hosts cannot steal a live lease. A worker that finds a
  live lease fails with a retryable `AttemptBusyError` and never fails the video on the owner's
  behalf.
- **Renewal.** A heartbeat renews the lease with a conditional `UPDATE` (the attempt must still
  match). Before uploading and before committing, the worker performs a verified renewal, which
  doubles as an ownership check. A former owner's renewal reports "lost" and the execution stops with
  a non-retryable `AttemptOwnershipLostError`. Renewal stops after `WORKER_ATTEMPT_MAX_SECONDS`
  (default 3 hours) so a wedged attempt becomes recoverable; `WORKER_LEASE_SECONDS` (default 60) sets
  the lease length. FFmpeg and uploads never run inside a database transaction.
- **Fenced publication.** The READY transition is the first statement of a short transaction and is
  fenced by status, generation, **and** attempt ID. In the same transaction it stores
  `committedAttemptId`, clears the lease, and publishes the asset rows. If the compare-and-set loses,
  the transaction rolls back and nothing is published.
- **Fenced failure.** `fail()` moves to FAILED only for the owning attempt and deletes storage
  _after_ that update succeeds, and then only the failing attempt's own prefix. A late failure from a
  superseded attempt, or after READY, changes nothing and deletes nothing.
- **Scoped cleanup.** A losing or cancelled attempt removes only its own `attempts/{attemptId}/`
  objects, and only after confirming the database does not record it as committed. If that state
  cannot be read, nothing is deleted: an orphan is recoverable, a deleted rendition is not. After a
  successful commit the winner sweeps legacy layouts, earlier generations, and losing attempts.

Network/storage/database failures are retryable; invalid probe output, unavailable media executables,
and deterministic FFmpeg failures are non-retryable. A retryable failure releases the lease so the next
delivery can start immediately. The video moves to FAILED only for a non-retryable error or after retry
exhaustion. Failure of one required rendition fails the entire attempt; no partial ladder is marked
READY. Every attempt removes its unique local working directory, including all rendition directories
and the master, in `finally`.

Prefix cleanup checks the per-key `Errors` returned by every S3 `DeleteObjects` request. The API keeps
a video in DELETING when any key failed; worker best-effort cleanup logs and propagates the partial
failure to its existing cleanup/retry boundary instead of silently declaring success.

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
MinIO object. A missing object preserves the existing domain conflict, while storage unavailability
returns 503. Two concurrent retry requests both observe FAILED at most briefly, but only one
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
Cleanup excludes unpublished rows **and** rows whose generation is still UPLOADED or PROCESSING, so
retention can never discard evidence that unfinished work needs for recovery.

### Reconciling stranded generations

Redis is disposable, and BullMQ can fail a job (a terminal stall) outside the worker's own error
handling, so a database row can say "work is pending" while nothing is running. Each API instance runs
a small, bounded `ProcessingReconciler` (every 30 seconds, at most 20 generations per scan, oldest
first). It considers a _published_ outbox event whose generation is still UPLOADED/PROCESSING, is
older than a grace period, and has **no valid attempt lease**; a generation with a live lease is never
touched. Each candidate is claimed with an atomic `lastRecoveredAt` update, so only one API instance
inspects it per cooldown window, and then BullMQ is asked for the job's state:

| BullMQ job                                                    | Database action                                                                                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| waiting, delayed, or active                                   | none; the work is healthy (or BullMQ's stall detection owns it)                                                                                                        |
| failed (retained)                                             | conditionally move to `FAILED`, clear the lease, and remove the dead attempt's objects; the owner can now use Retry                                                    |
| missing, or a retained `completed` job that no longer matches | revoke the expired owner, then re-publish idempotently (removing a retained finished job, which a plain `add` would silently ignore); counts toward `recoveryAttempts` |
| missing after `recoveryAttempts` reached the bound (5)        | conditionally move to `FAILED` so the owner can retry                                                                                                                  |

Revoking the expired owner first means a delayed former attempt can no longer renew or publish after
recovery. The worker also handles BullMQ's `failed` event for terminal failures (exhausted retries or
stalls) with the same lease-conditional `FAILED` update, so recovery is normally immediate and the
reconciler is the backstop. Outcomes are logged as `video.processing.reconciled` with the video ID,
generation, correlation ID, job state, and outcome only.

```text
stale job generation=1
          |
          v
DB processingGeneration=2
          |
          v
SKIP successfully
```

The worker checks generation and state before acquiring, then verifies attempt ownership before
generated upload and before the final READY transaction, whose update compare-and-sets PROCESSING,
the generation, and the attempt. A stale job or stale terminal failure therefore cannot change the
newer run. Lost ownership triggers best-effort cleanup of only that attempt's own objects. A
successful run best-effort removes older layouts, generations, and losing attempts but never the
ORIGINAL.

Visibility may change while FFmpeg is running. Processing completion first compare-and-sets READY,
then conditionally initializes `publishedAt` from the current database visibility. The API's publish
path performs the complementary check, so either ordering of the race leaves READY/PUBLIC published.

The worker verifies ownership before generated upload and again through the final compare-and-set. If
DELETING wins, the attempt's own prefix is removed and READY is never published. Upload intents are
capped by `MAX_UPLOAD_SIZE_BYTES` (2 GiB by default), the worker rejects media longer than two hours
before encoding, and each media subprocess retains its 15-minute timeout. These are laptop-oriented
guardrails.

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
generation-2 pipeline to READY with isolated, attempt-scoped authoritative assets. The browser test
generates a two-second 720p MP4, uploads it through the presigned POST policy, waits for READY,
verifies all three master variants, plays it, deletes the video, and removes the fixture. No media
binary is committed to the repository.

The remaining integration suites run against real PostgreSQL, Redis, and MinIO and need no FFmpeg:
attempt ownership (`apps/worker/test/attempt-ownership.integration.test.ts`, with a deterministic
fake media toolchain), and upload admission, upload completion, and processing reconciliation
(`apps/api/test/*.integration.test.ts`). Use disposable services. The reconciliation suite uses the
shared BullMQ queue name, so it must not run while a worker is consuming that queue.

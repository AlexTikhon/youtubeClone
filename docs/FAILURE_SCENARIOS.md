# Failure scenarios

This document describes implemented behavior, not an idealized production system. A **processing
generation** is one logical run requested by upload completion or an owner retry. A **BullMQ attempt**
is one infrastructure retry inside that generation.

## 1. PostgreSQL succeeds but the queue is unavailable

**What fails?** Upload completion or processing retry commits, but
`ProcessingOutboxPublisher` cannot add the job to BullMQ because Redis is unavailable.

**What happens?** The video state, original asset, generation, and unpublished outbox row remain in
PostgreSQL. The publisher records a generic publication failure and leaves `publishedAt` null. An
initial upload remains UPLOADED; an owner retry remains PROCESSING with `processingStartedAt` null.

**How does it recover?** The publisher scans unpublished rows every second and on API bootstrap. When
Redis returns, it enqueues the deterministic `video-{videoId}-generation-{generation}` job and marks
the outbox row published.

**Remaining limitation:** There is no dead-letter/operator alert workflow. PostgreSQL durability
prevents lost work, but processing waits until both the API publisher and Redis are available.

## 2. BullMQ delivers the same logical job twice

**What fails?** Publication can repeat after enqueue succeeds but before the outbox row is marked
published, or queue delivery can be repeated under at-least-once processing semantics.

**What happens?** The unique outbox key and deterministic BullMQ job ID suppress ordinary duplicate
publication. If execution is nevertheless repeated, the worker checks the generation and lifecycle.
A duplicate that sees READY logs `duplicate_skipped`; concurrent executions compete for the
UPLOADED-to-PROCESSING claim and later for the generation-specific READY claim.

**How does it recover?** Generation-isolated object keys, prefix cleanup before upload, asset upserts,
and compare-and-set state updates make repeated processing safe. Only one current generation can
become authoritative.

**Remaining limitation:** Duplicate execution can waste download/FFmpeg CPU before a later ownership
check. This is idempotent at-least-once behavior, not distributed exactly-once execution.

## 3. The worker crashes halfway through FFmpeg or upload

**What fails?** The worker process exits after claiming PROCESSING, possibly leaving a local temporary
directory or a partially uploaded generation prefix.

**What happens?** PostgreSQL remains PROCESSING. BullMQ detects the interrupted/stalled job and can
retry it according to the job's three-attempt policy. A new execution accepts the same PROCESSING
generation. Before uploading, it removes that generation's existing generated prefix, so partial
remote output is replaced.

**How does it recover?** Restarting a worker lets BullMQ redeliver available/stalled work. The retry
re-downloads, re-probes, and re-encodes the original and reuses the same logical generation.

**Remaining limitation:** An abrupt process or machine crash can leave an OS temporary directory;
there is no startup temp-directory sweeper. Recovery also depends on BullMQ retaining/redelivering the
job and on the worker returning before retry capacity is exhausted.

## 4. The user retries processing

**What fails?** A generation has reached FAILED after a non-retryable error or exhausted BullMQ
attempts.

**What happens?** `VideosService.retryProcessing` accepts only the owner of a FAILED video. It verifies
that exactly one ORIGINAL asset exists, checks its recorded metadata, and HEADs MinIO to confirm the
object still matches. A compare-and-set transaction changes FAILED to PROCESSING, increments the
generation, clears failure timestamps/reason, and creates the new outbox row. Concurrent retries
produce one success and one 409.

**How does it recover?** The outbox publisher queues the new deterministic generation job. The worker
processes it independently of prior generated paths.

**Remaining limitation:** Retry cannot repair a missing or changed original, and it restarts the whole
pipeline rather than resuming from a completed rendition.

## 5. An old processing generation wakes up

**What fails?** A delayed generation-1 job runs after the owner has started generation 2.

**What happens?** `VideoProcessingPipeline.execute` compares the job generation with
`Video.processingGeneration` before expensive work. A mismatch logs `stale_job_skipped` and returns
successfully. Further ownership checks occur before upload, before commit, and in the final READY
compare-and-set. `fail` also updates only matching PROCESSING/generation state.

**How does it recover?** No recovery is needed; stale work becomes a safe no-op and current-generation
work continues.

**Remaining limitation:** A generation can become stale while FFmpeg is already running, so CPU is not
cancelled immediately. The post-FFmpeg ownership check prevents publication and database mutation.

## 6. The user deletes a video while FFmpeg runs

**What fails?** The worker began with valid PROCESSING ownership, then the owner requests deletion.

**What happens?** `VideosService.delete` compare-and-sets the video to DELETING before object cleanup.
That status immediately fails watch/media authorization. The worker's next ownership check no longer
matches PROCESSING. If deletion wins during the asset transaction, the final READY update affects zero
rows and rolls the transaction back. The worker recognizes lost ownership and removes its generation
prefix.

**How does it recover?** Deletion removes the original, all stream/thumbnail prefixes, and finally the
database row. A `DeleteObjects` response containing any per-key error is treated as incomplete cleanup,
so the database row is not deleted. The row remains DELETING and the owner can repeat DELETE.

**Remaining limitation:** Cleanup is synchronous from the API caller's perspective and may be slow.
The best-effort worker cleanup can also fail during a storage outage, although a later deletion retry
targets the whole video prefix.

## 7. MinIO becomes unavailable

**What fails?** Direct upload, completion HEAD, worker download/upload, playback, or deletion cleanup
can fail depending on timing.

**What happens?** Browser PUT reports an upload error. Completion and processing retry return a safe
503 instead of claiming that the original is absent. Worker download and generated-asset upload errors
are classified retryable; BullMQ retries and eventually the video becomes FAILED if attempts are
exhausted. Media routes return `MEDIA_STORAGE_UNAVAILABLE` with 503. Deletion leaves the barrier in
DELETING and returns 503; partial bulk deletion is also failure rather than success.

**How does it recover?** The browser can repeat the full signed PUT while its in-memory upload context
exists; a FAILED processing generation can be retried after MinIO returns; DELETE can be repeated.
The worker readiness endpoint reports bucket failure.

**Remaining limitation:** The API readiness endpoint checks PostgreSQL and Redis, not MinIO, and there
is no automated orphan-object reconciler. A genuine missing object remains a 404/conflict according to
the endpoint; dependency unavailability is separately represented as 503.

## 8. Redis becomes unavailable

**What fails?** Outbox publication, queue consumption, Redis readiness, and rate-limit storage fail.

**What happens?** Unpublished outbox rows remain durable in PostgreSQL and media processing pauses.
API readiness becomes degraded/down for Redis. The fixed-window rate-limit guard logs the dependency
failure and fails open, so normal PostgreSQL-backed API operations continue.

**How does it recover?** Publisher and worker connections retry when Redis returns; unpublished work
is then queued. No lifecycle state is reconstructed from Redis because PostgreSQL is authoritative.

**Remaining limitation:** Abuse rate limits are not enforced during the outage, and no new media job
can begin until queue connectivity returns.

## 9. The API restarts

**What fails?** In-flight HTTP requests and the in-process outbox polling interval stop.

**What happens?** PostgreSQL sessions, video state, and outbox records survive. The worker and already
queued jobs do not depend on the API process.

**How does it recover?** On bootstrap, `ProcessingOutboxPublisher` immediately scans pending rows and
then continues every second. Clients can repeat idempotent or state-validated operations. Stored
opaque sessions remain valid until expiry or revocation.

**Remaining limitation:** A client may not know whether an interrupted mutation committed and must
refetch/retry. In-memory request context and rate-limit guard execution for that request are lost.

## 10. The worker restarts

**What fails?** Active FFmpeg and local temporary work stop; the BullMQ consumer disconnects.

**What happens?** The video can remain PROCESSING, while the durable queue and PostgreSQL state remain.
On a graceful shutdown, the worker closes its BullMQ connection; on an abrupt exit, BullMQ must detect
and recover the stalled job.

**How does it recover?** The new worker accepts a matching PROCESSING generation and reruns the whole
pipeline. Existing partial remote generation data is removed before new uploads.

**Remaining limitation:** Recovery time depends on BullMQ stalled-job detection and available
attempts. Abrupt local temp output is not explicitly swept on startup.

## 11. The browser closes during direct upload

**What fails?** The signed PUT or the later upload-completion request is never completed.

**What happens?** The database video remains UPLOADING with a PENDING `VideoUpload`. The 15-minute
signed URL expires. A partly transferred single PUT is not a completed MinIO object; a completely
stored object can remain unverified if the browser closed before calling completion.

**How does it recover?** While `VideoUploadForm` still has its in-memory context, Retry requests
another signed URL for the same key and same size/content type, performs the full PUT again, and calls
completion. The completion endpoint itself is safe to repeat.

**Remaining limitation:** After a page/browser restart there is no UI to reattach a local file to an
existing UPLOADING draft, no multipart resume, and no automatic expiry/cleanup policy for abandoned
upload rows or stored originals. This is a known portfolio-scope gap.

## 12. A playback manifest or segment request fails

**What fails?** The authorized API route, MinIO read, network, or browser decoder cannot provide the
next HLS resource.

**What happens?** The media route returns 404 only when the object is genuinely missing and a safe 503
when object storage is unavailable. With hls.js, fatal network errors call `startLoad` at most twice
and fatal media errors call `recoverMediaError` once. Exhaustion stops loading and displays a visible
error with **Retry playback**. Native HLS relies on the browser's loading behavior and the component's
media `error` handler.

**How does it recover?** The user retry destroys/recreates the playback attachment and starts again.
Component cleanup always destroys hls.js, removes listeners and the source, and reloads the media
element.

**Remaining limitation:** There is no offline cache, alternate origin/CDN failover, or persisted
segment retry policy beyond browser/hls.js behavior. A public media request still traverses the API.

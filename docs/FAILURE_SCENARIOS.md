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
A duplicate that sees READY (or FAILED) logs `duplicate_skipped`. Executions of the same generation
that overlap are told apart by an **attempt identity with a renewable database lease**: acquisition is
one atomic update, so a second execution that finds a live lease fails with a retryable
`AttemptBusyError` and never touches the owner's work. If the first lease expired (a stalled or slow
worker), the second execution takes over and the former owner becomes the loser.

**How does it recover?** Every attempt writes under its own `attempts/{attemptId}/` prefix. The READY
transition is fenced by generation **and** attempt ID and publishes the asset rows in the same
transaction, so exactly one attempt can become authoritative. A loser's `AttemptOwnershipLostError`
is non-retryable; its failure recording is a no-op because it no longer owns the generation, and it
deletes only its own unpublished objects. A late `fail()` after READY changes no lifecycle state and
deletes nothing.

**Remaining limitation:** Duplicate execution can still waste download/FFmpeg CPU before the next
ownership check; the lease stops a loser from _publishing_, not from encoding. This is idempotent
at-least-once behavior, not distributed exactly-once execution.

## 3. The worker crashes halfway through FFmpeg or upload

**What fails?** The worker process exits after claiming PROCESSING, possibly leaving a local temporary
directory or a partially uploaded generation prefix.

**What happens?** PostgreSQL remains PROCESSING, owned by the dead attempt until its lease (default 60
seconds) expires. BullMQ detects the interrupted/stalled job and can retry it according to the job's
three-attempt policy. The new execution takes over the expired lease with a fresh attempt ID and its
own output prefix; the dead attempt's partial objects are never reused or confused with the new
output.

**How does it recover?** Restarting a worker lets BullMQ redeliver available/stalled work. The retry
re-downloads, re-probes, and re-encodes the original under the same logical generation. If BullMQ
instead fails the job terminally, or loses it, the worker's `failed` handler and the API reconciler
(scenario 13) move the generation to a state the owner can retry.

**Remaining limitation:** An abrupt process or machine crash can leave an OS temporary directory and,
if the reconciler has not run yet, orphaned remote objects under the dead attempt's prefix; there is
no startup temp-directory sweeper.

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
successfully. Verified lease renewals occur before upload and before commit, and the final READY
compare-and-set requires the matching generation and attempt. `fail` also updates only a matching
PROCESSING/generation/attempt.

**How does it recover?** No recovery is needed; stale work becomes a safe no-op and current-generation
work continues.

**Remaining limitation:** A generation can become stale while FFmpeg is already running, so CPU is not
cancelled immediately. The post-FFmpeg ownership check prevents publication and database mutation.

## 6. The user deletes a video while FFmpeg runs

**What fails?** The worker began with valid PROCESSING ownership, then the owner requests deletion.

**What happens?** `VideosService.delete` compare-and-sets the video to DELETING before object cleanup.
That status immediately fails watch/media authorization. The worker's next ownership check no longer
matches PROCESSING. If deletion wins during the asset transaction, the final READY update affects zero
rows and rolls the transaction back. The worker recognizes the cancellation (not a failure) and
removes only its own attempt prefix.

**How does it recover?** Deletion removes the original, all stream/thumbnail prefixes, and finally the
database row. A `DeleteObjects` response containing any per-key error is treated as incomplete cleanup,
so the database row is not deleted. The row remains DELETING and the owner can repeat DELETE.

**Remaining limitation:** Cleanup is synchronous from the API caller's perspective and may be slow.
The best-effort worker cleanup can also fail during a storage outage, although a later deletion retry
targets the whole video prefix.

## 7. MinIO becomes unavailable

**What fails?** Direct upload, completion HEAD, worker download/upload, playback, or deletion cleanup
can fail depending on timing.

**What happens?** The browser's direct storage upload reports an upload error. Completion and processing retry return a safe
503 instead of claiming that the original is absent. Worker download and generated-asset upload errors
are classified retryable; BullMQ retries and eventually the video becomes FAILED if attempts are
exhausted. Media routes return `MEDIA_STORAGE_UNAVAILABLE` with 503. Deletion leaves the barrier in
DELETING and returns 503; partial bulk deletion is also failure rather than success.

**How does it recover?** The browser can repeat the full upload with a re-signed policy while its
in-memory upload context exists; a FAILED processing generation can be retried after MinIO returns; DELETE can be repeated.
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

**How does it recover?** After the dead attempt's lease expires, the new worker takes the generation
over with a new attempt and reruns the whole pipeline under a fresh output prefix. A graceful shutdown
releases nothing early; the lease simply runs out. If BullMQ gave up on the job, scenario 13 applies.

**Remaining limitation:** Recovery time depends on the lease length and BullMQ stalled-job detection.
Abrupt local temp output is not explicitly swept on startup.

## 11. The browser closes during direct upload

**What fails?** The storage upload or the later upload-completion request is never completed.

**What happens?** The database video remains UPLOADING with a PENDING `VideoUpload`. The 15-minute
signed policy expires. A partly transferred upload is not a completed MinIO object; a completely
stored object can remain unverified if the browser closed before calling completion.

**How does it recover?** While `VideoUploadForm` still has its in-memory context, **Retry upload**
requests a fresh policy for the same key and same size/content type, uploads the form again, and
calls completion. The completion endpoint itself is idempotent (scenario 15).

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

**How does it recover?** The user retry destroys/recreates the playback attachment and starts again,
resuming at the position reached rather than the stale saved resume point. Component cleanup always
destroys hls.js, removes listeners and the source, and reloads the media element. Ordinary metadata
refetches (a subscription, a view count, a history save) do not rebuild a healthy attachment
(scenario 16).

**Remaining limitation:** There is no offline cache, alternate origin/CDN failover, or persisted
segment retry policy beyond browser/hls.js behavior. A public media request still traverses the API.

## 13. A processing generation is stranded

**What fails?** PostgreSQL says UPLOADED/PROCESSING but no worker will ever run the work: the Redis job
vanished (flush, eviction, failover), or BullMQ failed it terminally outside the worker's own error
handling (a stall limit), so `process()`'s catch block never recorded a failure.

**What happens?** The worker's BullMQ `failed` handler moves a terminally failed job's generation to
FAILED, but only when no valid attempt lease exists. Independently, every API instance runs a bounded
reconciler over _published_ outbox events whose generation is still pending, older than a grace
period, and without a valid lease. It asks BullMQ for the job's state: a waiting, delayed, or active
job is left alone; a retained failed job becomes FAILED (owner Retry then works); a missing job, or a
retained completed job that no longer matches the database, is re-published after the expired owner is
revoked (so a delayed former attempt cannot publish). Scans, per-generation inspections, and
re-publications are bounded, and only one instance wins each claim.

**How does it recover?** Re-publication is idempotent. After the recovery bound (5) the generation is
moved to FAILED so the owner can retry. Outbox rows for unfinished generations are never expired by
retention. Every outcome logs a `video.processing.reconciled` event with the video, generation,
correlation ID, job state, and outcome.

**Remaining limitation:** An `active` job whose worker is gone stays active until some worker starts
and BullMQ's stall detection runs. Detection latency is the grace period plus up to one scan interval.
The reconciler does not touch UPLOADING videos whose upload never completed.

## 14. A client uploads more bytes than it declared

**What fails?** The declared size passes `MAX_UPLOAD_SIZE_BYTES`, but the client (honestly or not)
sends a different number of bytes.

**What happens?** The presigned POST policy carries `content-length-range [declared, declared]` plus
the exact key and content type, so MinIO/S3 rejects the upload (`EntityTooLarge`, `EntityTooSmall`, or
`AccessDenied`) before storing it. Completion still verifies size and content type as defense in depth.
An expired policy is rejected by storage too.

**How does it recover?** The browser shows a specific message and offers **Retry upload**, which
re-signs the same intent for the same declared size.

**Remaining limitation:** The enforced size is the _declared_ size; a client can declare any size up to
the limit. A single POST has no multipart resume, so large interrupted uploads restart from zero.

## 15. The completion response is lost

**What fails?** `POST /upload/complete` commits (and a worker may already have started or finished),
but the response never reaches the browser.

**What happens?** Completion is idempotent: replaying it returns the current lifecycle state with
`alreadyCompleted: true`, never a second asset or outbox event, and concurrent calls race on one
compare-and-set. The upload form treats a network error or 5xx as _uncertain_ and reads the owner's
view of the video before choosing a recovery: accepted states keep observing processing; a video still
UPLOADING gets a **Retry finalization** button that never re-sends the bytes; only a video that never
received the bytes offers **Retry upload**. A FAILED processing generation shows a separate
**Retry processing** action.

**How does it recover?** The recoveries are separate and non-destructive: finalize, upload again, or
retry processing, depending on what actually happened.

**Remaining limitation:** The upload context lives in component memory; after a page reload the owner
must use Studio (processing retry) or start a new upload. Authorization and deletion still apply to
every replay (other owners get 404; a deleting video is rejected).

## 16. Watch metadata refetches during playback

**What fails?** A subscription, a counted view, or a history save refetches the watch detail while the
video is playing, and the saved resume position it reports is older than the current position.

**What happens?** The player's attachment lifetime depends only on the playback URL and an explicit
retry. The resume position is read once when a source attaches, so a metadata refetch neither reloads
the media element, destroys hls.js, nor seeks.

**How does it recover?** Nothing needs recovering. A new source starts at its own saved position; an
explicit **Retry playback** resumes where playback got to.

**Remaining limitation:** Resume is applied on `loadedmetadata`; a browser that never fires it does not
resume, as before.

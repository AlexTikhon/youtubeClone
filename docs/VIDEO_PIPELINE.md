# Video pipeline

## Implemented foundation

```text
DRAFT → UPLOADING → UPLOADED
           │
           └─ signed PUT → video-originals
UPLOADED ── versioned BullMQ job ──> worker validation
```

The API stores a `VideoUpload` intent before creating the signed URL. Completion uses `HEAD` to
verify the object and expected byte size, then creates an `ORIGINAL` `VideoAsset`. Enqueueing happens
after the database transaction. Signed-URL issuance and upload completion are retryable, while the
deterministic BullMQ job ID prevents normal duplicate submissions.

## Phase 1 target

```text
upload validation
  → enqueue
  → claim UPLOADED → PROCESSING
  → ffprobe metadata
  → thumbnail generation
  → bounded rendition transcodes
  → HLS manifests and segments
  → upload video-thumbnails / video-streams
  → transactional asset records
  → READY
```

Failures move `PROCESSING → FAILED` with a safe reason after BullMQ retry policy is exhausted. Retry
moves `FAILED → PROCESSING`. The worker must write to temporary per-job paths, make output object keys
deterministic, and only expose a manifest after every referenced object exists. A compensating
reconciliation job should repair the small database/queue dual-write window; a transactional outbox
is warranted only if experience shows that retries and reconciliation are insufficient.

Allowed lifecycle transitions are explicit application logic. Neither controllers nor storage
callbacks mutate status directly. `READY` means a playable manifest and required metadata exist—not
merely that a queue job completed.

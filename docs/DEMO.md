# 5–10 minute demo

## Before the interview

```powershell
Copy-Item .env.example .env # first run only
pnpm setup
docker compose --profile media up -d --build worker
pnpm dev:app
```

Open the web app, API health endpoint, and optionally BullMQ/MinIO logs in separate tabs. Keep a tiny
MP4 ready. The media E2E generates such a fixture automatically if you want a rehearsal.

## Script

1. **Orient the system (60 seconds).** Show the diagram in [INTERVIEW.md](INTERVIEW.md). Explain that
   request/response product logic stays in a NestJS modular monolith while CPU-heavy media work is a
   separate process.
2. **Log in (30 seconds).** Use `developer@example.test` and the local seed password. Point out the
   opaque HttpOnly cookie and server-side revocation model.
3. **Upload an MP4 (90 seconds).** In Studio, create a video and show browser-to-MinIO progress.
   Explain that NestJS issues the signed intent but does not proxy the large request body.
4. **Watch processing (60 seconds).** Show `UPLOADING -> UPLOADED -> PROCESSING -> READY`. Mention
   ffprobe as the authority for media validity, deterministic output keys, three BullMQ attempts, and
   worker concurrency one locally.
5. **Play HLS (45 seconds).** Open the completed video. Explain native HLS where supported, hls.js
   elsewhere, and API-mediated authorization for manifests, segments, and thumbnails.
6. **Exercise product state (60 seconds).** Like, comment, subscribe, watch long enough for a qualified
   view, and show resume/history behavior. These are composite-key/upsert-backed idempotent writes.
7. **Show discovery (60 seconds).** Search for the uploaded title, then open related videos. Mention
   trigger-maintained weighted PostgreSQL FTS, the partial GIN index, runtime validation of raw SQL
   rows, and cursor-stable ranking time.
8. **Show playlists (45 seconds).** Save the video to Watch Later. Explain the partial unique index for
   one system playlist per owner and the transaction-scoped advisory lock for positions.
9. **Finish in Studio (30 seconds).** Change visibility, then explain the `DELETING` barrier and why a
   worker cannot resurrect a deleted video.

## Useful follow-up tabs

- `GET /api/v1/health/ready` for dependency readiness
- `docs/VIDEO_PIPELINE.md` for retry/failure sequencing
- `docs/SEARCH.md` for ranking and query-plan nuance
- `.github/workflows/ci.yml` for the verification pipeline

The seeded READY card supports the fast product E2E but has no seeded media objects. Use a real upload
when demonstrating playback; this keeps the repository free of committed binary video artifacts.

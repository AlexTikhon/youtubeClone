# Architecture

## Boundaries

The repository is a pnpm monorepo with three deployable applications and four small shared
packages. The API is a modular monolith organized around business capabilities. PostgreSQL is the
source of truth, Redis carries disposable queue state, and MinIO stores large binary objects.

```text
Next.js web ──REST/cookie──> NestJS API ──> PostgreSQL
     │                           │
     └──── signed PUT ──────> MinIO
                                 ▲
API ── versioned job ──> Redis/BullMQ ──> worker
```

- `apps/web`: App Router UI, feature-oriented upload code, typed API client, React Query server
  state, and local form state through React Hook Form.
- `apps/api`: authentication, videos, uploads, health, and infrastructure adapters. Controllers
  translate HTTP; services own workflows; the state machine owns valid lifecycle changes.
- `apps/worker`: independently scalable BullMQ consumer. It validates a versioned payload before
  handing work to the processing pipeline boundary.
- `packages/types`, `validation`, `config`, `ui`: narrow shared contracts only; no generic utility
  package.

## Request and dependency direction

HTTP controllers depend on application services. Upload application code depends on object-storage
and queue ports because those are genuine replacement/failure boundaries. Concrete S3 and BullMQ
adapters live under API infrastructure. Prisma is used directly by focused services; a generic
repository would add ceremony without protecting a useful boundary.

Every request receives a validated or generated request ID, returned in `x-request-id` and structured
errors. Logs carry that ID and add `userId`, `videoId`, and `jobId` where known. Errors follow:

```json
{
  "error": {
    "code": "VIDEO_NOT_FOUND",
    "message": "Video was not found",
    "requestId": "..."
  }
}
```

Cursor page contracts exist for future collection endpoints; no unused pagination machinery is
implemented yet. OpenAPI is served outside the versioned API at `/api/docs`.

## Authentication

Opaque random session tokens are intended to be issued in cookies with `HttpOnly`, `Secure` in
production, and `SameSite=Lax`. Only a SHA-256 token hash is stored in PostgreSQL. The API guard owns
cookie-to-user resolution; downstream features receive an authenticated user context and never parse
tokens. This costs a database/cache lookup but enables immediate revocation and avoids browser token
storage. Login, CSRF hardening for cross-site deployments, rotation, and logout are Phase 1 work.

## Operations

`/api/v1/health/live` checks the process. `/api/v1/health/ready` checks PostgreSQL and Redis with
short timeouts. JSON console logging is intentionally the only observability infrastructure in this
phase; container/runtime log collection can consume it later.

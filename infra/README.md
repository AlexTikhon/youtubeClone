# Local infrastructure

Docker Compose defines PostgreSQL, Redis, MinIO, and a one-shot MinIO bucket initializer. Persistent
data lives in named Docker volumes; host ports and bucket names come from the root `.env` file.

Application containers are intentionally omitted in Phase 0 so web/API/worker development keeps fast
local hot reload. The infrastructure network still uses service DNS and standard container ports,
while host bindings are restricted to `127.0.0.1`.

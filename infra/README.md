# Local infrastructure

Docker Compose defines PostgreSQL, Redis, MinIO, and a one-shot MinIO bucket initializer. Persistent
data lives in named Docker volumes; host ports and bucket names come from the root `.env` file.

Web and API development stays on the host for fast reload. The optional `media` Compose profile adds
an FFmpeg-equipped worker for reproducible processing when FFmpeg is not installed locally:

```bash
docker compose --profile media up -d --build worker
```

The container uses service DNS and internal ports, while host infrastructure bindings remain
restricted to `127.0.0.1`. Do not run the host worker and Compose worker simultaneously.

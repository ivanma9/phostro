# phostro

Photo-courier MVP — Next.js + Postgres + pgvector. See `docs/plans/2026-04-27-photo-courier-implementation.md` for the implementation plan.

## Setup

1. `cp .env.example .env.local` and fill in:
   - `DATABASE_URL` — your dev Postgres (Supabase / Neon branch — **never** the production project DB).
   - `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres` — for the local Docker test DB.
   - `SESSION_SECRET` — must be ≥ 32 chars. Generate via `openssl rand -hex 32`.
   - `RESEND_API_KEY` — only needed when you want real emails to send.
2. `pnpm install`
3. Enable the `vector` extension on your dev DB:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
4. **R2 storage (Phase 2)** — for photo uploads:
   - In the Cloudflare dashboard, create an R2 bucket named `phostro-photos` (private — do NOT enable the public dev URL).
   - Create an **R2 API Token** with **Object Read & Write** permission scoped to that bucket. Copy the Access Key ID, Secret Access Key, and Account ID into `.env.local`:
     ```
     R2_ACCOUNT_ID=<account hash, no URL prefix>
     R2_ACCESS_KEY_ID=<from token>
     R2_SECRET_ACCESS_KEY=<from token>
     R2_BUCKET=phostro-photos
     ```
   - **CORS policy** (Bucket → Settings → CORS Policy):
     ```json
     [{
       "AllowedOrigins": ["http://localhost:3000", "http://localhost:3010"],
       "AllowedMethods": ["GET", "PUT", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }]
     ```
   - **Lifecycle rule** (Bucket → Settings → Object Lifecycle Rules): "Delete after 1 day" — Cloudflare auto-cleans abandoned uploads. (Phase 2 accepts whole-bucket scope; Phase 6 will add a per-prefix scope if needed.)
   - For CI, add the same 4 keys to your GitHub repository secrets (values can be `ci-fake-*` dummies — unit tests mock R2; only `pnpm build` cares the env exists).

## Common commands

| Command | What it does | Targets |
|---|---|---|
| `pnpm dev` | Next.js dev server | reads `.env.local` (`DATABASE_URL`) |
| `pnpm build` | Production build | reads `.env.local` |
| `pnpm db:generate` | Generate a new migration from `db/schema.ts` | n/a |
| `pnpm db:migrate` | **Apply migrations to dev DB** | `DATABASE_URL` from `.env.local` |
| `pnpm db:studio` | Drizzle Studio against dev DB | `DATABASE_URL` |
| `pnpm test:db:up` | Start the local Docker Postgres for tests | port 54329 |
| `pnpm test:db:migrate` | Apply migrations to the test DB | hard-coded local URL |
| `pnpm test:db:down` | Stop & wipe the test DB | — |
| `pnpm test` | Vitest unit + integration tests | `TEST_DATABASE_URL` (required) |
| `pnpm test:e2e` | Playwright e2e | `TEST_DATABASE_URL` (required) |
| `pnpm lint` / `pnpm check` | Biome lint (check / autofix) | — |

`pnpm test` and `pnpm test:e2e` will refuse to run if `TEST_DATABASE_URL` is unset — by design, so a stray run can never mutate the dev DB.

## Local dev with worker

Use Docker Compose to run the full stack (web + worker + dispatcher + Postgres) locally with a single command.

### Prerequisites

1. **Docker Desktop** (or Docker Engine + Compose v2).
2. **Model files** — the face-detection and recognition ONNX models must be present at:
   ```
   bench/models/det_10g.onnx
   bench/models/face_recognition_sface_2021dec.onnx
   ```
   These are gitignored. Copy them from a teammate or run `bench/download-models.sh` if it exists.
3. **`.env.local`** — set at minimum:
   ```
   WORKER_SECRET=<any secret, ≥ 32 chars>
   SESSION_SECRET=<any secret, ≥ 32 chars>
   # R2 credentials if you want photo uploads to work:
   R2_ACCOUNT_ID=...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_BUCKET=phostro-photos
   ```
   Compose reads `.env.local` automatically via Docker Compose's env-file resolution.
   If `WORKER_SECRET` is unset, a clearly-marked dev default is used — **never use the default in production**.

### Ports

| Service  | Host port | Notes                                          |
|----------|-----------|------------------------------------------------|
| web      | 3000      | Next.js dev server with hot reload             |
| worker   | 8000      | Python/FastAPI face-recognition worker         |
| db       | **54330** | Dev Postgres — avoids conflict with test DB (54329) |

If you run both the dev compose stack and `pnpm test:db:up` simultaneously, ports will not conflict.

### Workflow

```bash
make up        # Build images and start all services (foreground, Ctrl-C to stop)
make stop      # Stop containers, keep DB data (pg_data volume preserved)
make down      # Stop containers AND wipe volumes — fresh start
make logs      # Tail logs from worker + dispatcher only
make migrate   # Run pending DB migrations inside the web container
make smoke     # Health-check /health endpoints + assert no failed jobs
```

First boot is slow — the web and dispatcher containers install `node_modules` inside
the container on first start. Subsequent starts reuse the named `web_node_modules`
and `dispatcher_node_modules` volumes.

### Architecture note

The `worker/.dockerignore` file is **not** needed and has not been created. The
`worker/Dockerfile` uses the repo root as its build context (`build: { context: .,
dockerfile: worker/Dockerfile }`), so the root `.dockerignore` already excludes
`node_modules`, `.env*`, `bench/models`, etc.

## Tech

Next.js 16 (App Router) · React 19 · Tailwind 4 · Drizzle ORM + postgres-js · pgvector · iron-session · Resend · Vitest · Playwright · Biome.

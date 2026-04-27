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

## Tech

Next.js 16 (App Router) · React 19 · Tailwind 4 · Drizzle ORM + postgres-js · pgvector · iron-session · Resend · Vitest · Playwright · Biome.

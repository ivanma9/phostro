# Phase 2 Design — Upload + Storage

**Goal:** Authenticated event member uploads photos through the browser; server registers each photo in Postgres and generates a 2048px JPEG preview. Originals plus previews live in Cloudflare R2.

Builds on Phase 1 (`docs/plans/2026-04-27-photo-courier-implementation.md`). Sets up infrastructure that Phase 3's recognition worker will hook into.

---

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Server-side preview generation with **Sharp** (not Cloudflare Image Resizing) | Avoids needing a custom domain on R2; full control; no per-image cost. Costs ~200–400 ms per upload, accepted. |
| 2 | **Synchronous** preview generation (in finalize POST) | Simplest possible pipeline. Phase 3 builds the queue infrastructure for async work. |
| 3 | **JPEG q=95** original + **JPEG q=85, max 2048×2048** preview, both stored in R2 | Universal compatibility (no HEIC download issues), low storage cost. |
| 4 | **R2 lifecycle rule on `pending/`** prefix, 24-hour TTL | Cloudflare cleans up orphans; zero cron code. |
| 5 | **Multi-select + drag-and-drop** picker, **parallel batch of 3**, **aggregate progress bar** | P3 from brainstorm — meaningful speedup, simple state. |
| 6 | **Extract `taken_at`** from EXIF, **strip everything else** from both original and preview | Chronological gallery order matters; no GPS leakage. |
| 7 | Caps: **25 MB/photo**, **5,000 photos/event**, **no per-attendee cap**, allow JPEG/PNG/HEIC/HEIF | Defensive but not paranoid. |

---

## Architecture

**Stack additions:**
- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — R2 access (S3-compatible).
- `sharp` — JPEG/HEIC decode, resize, re-encode.
- `exifr` — lightweight EXIF reader for `DateTimeOriginal`.
- Node runtime on photo routes (`export const runtime = 'nodejs'`); Sharp can't run on Edge.

**Three API routes:**
1. `POST /api/events/:id/photos/init` — issues presigned PUT URL pointing at `pending/<photoId>.bin`. Validates membership, MIME, size, event cap.
2. Browser uploads bytes directly to R2 via presigned URL. App server bandwidth = zero.
3. `POST /api/events/:id/photos/:photoId/finalize` — fetches from `pending/`, runs Sharp pipeline, writes `original/<id>.jpg` + `preview/<id>.jpg`, inserts row, deletes `pending/`.

**Storage layout in R2:**
- `pending/<uuid>.bin` — browser-uploaded, transient (lifecycle: 24h).
- `original/<uuid>.jpg` — canonical archive.
- `preview/<uuid>.jpg` — gallery rendering.

---

## Schema additions

One new table; no changes to existing.

```ts
export const photos = pgTable(
  'photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    uploaderUserId: uuid('uploader_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    r2KeyOriginal: text('r2_key_original').notNull(),
    r2KeyPreview: text('r2_key_preview').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sizeBytesOriginal: integer('size_bytes_original').notNull(),
    takenAt: timestamp('taken_at'),
    hasDetectedFaces: boolean('has_detected_faces'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('photos_event_id_idx').on(t.eventId),
    index('photos_event_taken_at_idx').on(t.eventId, t.takenAt.desc()),
  ],
)
```

Notes:
- `r2Key*` stored explicitly (not derived) for migration flexibility.
- `hasDetectedFaces` is **nullable**: `null` = Phase 3 hasn't processed; `false` = processed, no faces; `true` = processed, has faces.
- `takenAt` nullable — not all photos have EXIF (screenshots, edits).
- No `mimeType` (everything's JPEG post-finalize) and no `status` (rows only inserted on success).

Composite index `(event_id, taken_at desc)` is the gallery's primary query.

---

## Data flow

```
Browser                  Next.js API              R2                     Postgres
   │                          │                    │                         │
   │  POST .../photos/init    │                    │                         │
   │  {filename, mime, size}  │                    │                         │
   ├─────────────────────────►│  check member      │                         │
   │                          │  check event cap   │                         │
   │                          │  validate MIME     │                         │
   │                          ├──── presign  ─────►│                         │
   │ ◄──{photoId, putUrl}─────┤                    │                         │
   │                          │                    │                         │
   │  PUT bytes               │                    │                         │
   ├──────────────────────────┼───────────────────►│                         │
   │                          │                    │                         │
   │  POST .../finalize       │                    │                         │
   ├─────────────────────────►│  GET pending/      │                         │
   │                          ├───────────────────►│                         │
   │                          │ ◄────  bytes  ─────┤                         │
   │                          │                    │                         │
   │                          │  Sharp pipeline:                             │
   │                          │   decode → rotate → extract EXIF             │
   │                          │   q=95 JPEG + q=85 2048px JPEG               │
   │                          │                    │                         │
   │                          │  PUT original/, preview/                     │
   │                          ├───────────────────►│                         │
   │                          │  DELETE pending/   │                         │
   │                          ├───────────────────►│                         │
   │                          │                                              │
   │                          │  INSERT photos row                           │
   │                          ├──────────────────────────────────────────────►
   │ ◄────{photo: {...}}──────┤                    │                         │
```

**Browser orchestration:** Fixed concurrency = 3. `Promise.all` over batches; each file does init → PUT → finalize as one async unit. Aggregate progress = `done / total`.

---

## Error handling

**Init validation (fail-fast in this order):**
1. Authenticated → else 401.
2. Member of event → else 403.
3. Event not expired → else 410 Gone.
4. MIME ∈ allowlist → else 400.
5. Declared size ≤ 25 MB → else 413.
6. Event photo count < 5000 → else 429.

The MIME/size from init are untrusted client claims; real validation happens in finalize after Sharp tries to decode.

**Finalize is idempotent:**
- Second POST with same `photoId` → `GET pending/` returns 404, we look up existing `photos` row by id and return it. Pattern mirrors `/api/auth/verify` from Phase 1.
- `INSERT` uses `ON CONFLICT (id) DO NOTHING RETURNING *` + fallback SELECT.

**Sharp failure modes:**
- Corrupt / unsupported format → 422. Browser surfaces error; R2 lifecycle cleans up.
- HEIC handled natively by Sharp 0.34+ (libheif).
- Buffer cap of 50 MB before Sharp invocation (defense-in-depth above the 25 MB init claim).

**Cap race:**
Two simultaneous finalize calls at the 4999→5000 boundary. Count check inside a `SELECT … FOR UPDATE` transaction; loser returns 429 and deletes its pending object.

**Orientation:** `sharp(...).rotate()` (no args) auto-rotates per EXIF and strips the tag. Always renders upright everywhere.

**Out of scope for Phase 2 (deferred):**
- Resumable uploads (tus / S3 multipart). Phase 6 if attendees complain about flaky networks.
- Same-photo-uploaded-twice deduplication. Phase 5+.
- Content moderation. Out of MVP scope.
- Animated GIFs (`image/gif` not on allowlist).

---

## Testing

**Unit (Vitest, no DB, no R2):**
- `lib/photos/process.ts` — `processImage(buffer): {originalJpeg, previewJpeg, width, height, takenAt}`. Tests cover: JPEG round-trip, HEIC→JPEG conversion, EXIF orientation rotation correctness, orientation tag stripped from output, GPS dropped from output, `DateTimeOriginal` extraction, corrupt input throws typed error.
- `lib/photos/r2.ts` — wraps `@aws-sdk/client-s3`. Mock S3 client for unit tests; assert correct bucket/key/body passed.

**Test fixtures:** `tests/setup-fixtures.ts` runs once before tests; generates 4 small images via Sharp (a plain JPEG, an HEIC built from it, a JPEG with EXIF orientation=6, a JPEG with GPS in EXIF). Output to `tests/fixtures/photos/`. Directory in `.gitignore` — regenerated each run.

**Integration (Vitest + Docker test DB, R2 mocked at module level):**
- `init` route — happy path + 401, 403, 410, 400, 413, 429.
- `finalize` route — happy path inserts row + idempotent re-call returns same row + race returns 429 with cleanup + Sharp failure returns 422.
- S3 client faked via `vi.mock` pointing at an in-memory `Map<key, Buffer>`.

**E2E (Playwright):**
- One test: seed host via test-only `/api/test/sign-in-as` route (guarded by `NODE_ENV === 'test'`), navigate to `/events/:id`, upload 3 fixture images via file input, assert gallery shows 3 thumbnails.
- `webServer` env in `playwright.config.ts` extended with `R2_*` pointing at a dedicated test bucket (`e2e-` prefix) or a local fake.

**Skipping:** load testing, quota-exhaustion drills, concurrency stress beyond the 2-call race already covered.

---

## What's done by end of Phase 2

- Schema migration `0004_*_add_photos.sql` applied to Supabase + Docker.
- R2 bucket with `pending/` lifecycle rule and CORS allowing localhost origins.
- `lib/photos/process.ts`, `lib/photos/r2.ts` with full test coverage.
- `/api/events/:id/photos/init`, `/api/events/:id/photos/:photoId/finalize` — TDD'd.
- Upload UI on `/events/[id]` page (host + attendee both can upload). Drag-and-drop, multi-select, batch-of-3 concurrency, aggregate progress.
- Gallery list view: thumbnails (preview JPEG), sorted by `taken_at desc` falling back to `created_at desc`.
- Playwright e2e covering full upload happy path.
- Docs/README updated: how to run R2-backed tests locally.

What's intentionally **not** in Phase 2:
- Face detection — Phase 3.
- "You / By Me / Other" gallery tabs — Phase 5.
- Per-photo download (raw original) — Phase 5.
- Bulk download — Phase 5.
- Email notifications on new uploads — Phase 6.

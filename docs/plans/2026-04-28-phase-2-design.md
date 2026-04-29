# Phase 2 Design — Upload + Storage

**Goal:** Authenticated event member uploads photos through the browser; server registers each photo in Postgres and generates a 2048px JPEG preview. Originals (re-encoded as JPEG q=95) plus previews live in Cloudflare R2. The Phase 2 read surface is **uploader-only** ("By Me") — full visibility-aware gallery ships in Phase 5.

Builds on Phase 1 (`docs/plans/2026-04-27-photo-courier-implementation.md`). Sets up infrastructure that Phase 3's recognition worker hooks into directly.

> **Revised 2026-04-29** after code review by Codex. Eight Critical/Important issues from that review are folded in below; a one-paragraph "Review changes" note appears at the end.

---

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Server-side preview generation with **Sharp** (not Cloudflare Image Resizing) | Avoids needing a custom domain on R2. Full control. ~200–400 ms per upload. |
| 2 | **Synchronous** preview generation in finalize | Simplest pipeline. Phase 3 builds the queue infrastructure for async work. |
| 3 | **JPEG q=95** original + **JPEG q=85, max 2048×2048** preview, both in R2 | Universal compatibility (no HEIC download issues), low cost. **Overrides product design line 25** ("originals stored as-is"); the trust contract becomes "your photo, in a format every device can open." |
| 4 | **R2 lifecycle on `events/{eventId}/pending/`**, 24-hour TTL | Cloudflare cleans up orphaned uploads; zero cron code. |
| 5 | **Multi-select + drag-and-drop** picker, **parallel batch of 3**, **aggregate progress bar** | Meaningful speedup, simple state. |
| 6 | **Extract `taken_at`** from EXIF, **strip everything else** from both objects | Chronological gallery; no GPS leakage. |
| 7 | Caps: **25 MB/photo**, **5,000 photos/event**, **no per-attendee cap**, allow JPEG/PNG/HEIC/HEIF | Defensive but not paranoid. |
| 8 | **Private R2 bucket.** No public dev URL. Both preview and original served through Next.js routes that check event membership. | Required by product design line 26 (Personal mode default); without this, all visibility modes fail. |
| 9 | **Photos row created at `init` time**, not at finalize | Binds `photoId` to uploader + event at the moment of presigned-URL minting. Closes IDOR / upload-hijack window. |

---

## Architecture

**Stack additions:**
- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — R2 access (S3-compatible).
- `sharp` — JPEG/HEIC decode, resize, re-encode.
- `exifr` — lightweight EXIF reader for `DateTimeOriginal`.
- Node runtime on photo routes (`export const runtime = 'nodejs'`).

**Three write API routes:**
1. `POST /api/events/:id/photos/init` — validates membership, MIME, declared size, event cap (with row lock). **Inserts a `photos` row** with `processingState='pending'`, returns presigned PUT URL pointing at `events/<eventId>/pending/<photoId>.bin`.
2. Browser uploads bytes directly to R2 via presigned URL. App-server bandwidth = zero.
3. `POST /api/events/:id/photos/:photoId/finalize` — loads the `photos` row, **verifies the row's `uploaderUserId` matches the caller** (closes IDOR), HEADs the pending object to enforce real size, fetches it, runs Sharp, writes original/preview, deletes pending, sets `processingState='ready'` + final metadata.

**Two read API routes:**
4. `GET /api/photos/:photoId/preview` — checks membership in the photo's event, streams `preview/<id>.jpg` bytes from R2 through Next.js to browser. No URL leakage.
5. `GET /api/photos/:photoId/original` — same auth, streams the original. Used by per-photo download in Phase 5; in Phase 2 only available to the uploader (their "By Me" tab).

**Storage layout in R2** (event-scoped prefixes for trivial per-event cleanup):
- `events/<eventId>/pending/<photoId>.bin` — transient, lifecycle-purged at 24 h.
- `events/<eventId>/original/<photoId>.jpg` — canonical archive (q=95).
- `events/<eventId>/preview/<photoId>.jpg` — gallery rendering (q=85, ≤2048px).

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

    // State machine. 'pending' inserted at init; 'ready' on successful
    // finalize; 'failed' on Sharp error / size cap exceeded post-PUT.
    processingState: text('processing_state', {
      enum: ['pending', 'ready', 'failed'],
    })
      .notNull()
      .default('pending'),

    // R2 keys
    pendingKey: text('pending_key'),                    // set at init, cleared on finalize
    r2KeyOriginal: text('r2_key_original'),             // set on finalize success
    r2KeyPreview: text('r2_key_preview'),               // set on finalize success

    // Source metadata
    declaredMimeType: text('declared_mime_type').notNull(),
    declaredSizeBytes: integer('declared_size_bytes').notNull(),
    originalFilename: text('original_filename'),        // from client; trimmed to 255 chars

    // Set on finalize success
    width: integer('width'),
    height: integer('height'),
    sizeBytesOriginal: integer('size_bytes_original'),
    takenAt: timestamp('taken_at'),
    uploadedAt: timestamp('uploaded_at'),               // when state→'ready'

    // Phase 3 substrate
    hasDetectedFaces: boolean('has_detected_faces'),

    // Soft delete
    deletedAt: timestamp('deleted_at'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('photos_event_id_idx').on(t.eventId),
    index('photos_event_taken_at_idx').on(t.eventId, t.takenAt.desc()),
    index('photos_event_state_idx').on(t.eventId, t.processingState),
    index('photos_uploader_event_idx').on(t.uploaderUserId, t.eventId),
  ],
)
```

**Notes:**
- Three states: `pending` (init done, awaiting bytes / Sharp), `ready` (gallery-visible), `failed` (terminal error). Failed rows stay for debugging; lifecycle cleanup deletes them in Phase 6.
- `r2Key*` and image dimensions are nullable because they're populated only on `ready`.
- `(uploaderUserId, eventId)` index serves the Phase 2 "By Me" query.
- `(eventId, processingState)` index serves Phase 3's "find pending photos to process" query.
- No queue table (`photo_jobs`) yet — Phase 3 adds it. The state column gives Phase 3 a foreign-keyable handle.

**One migration:** `0004_*_add_photos.sql`. Apply to Supabase + Docker test DB.

---

## Data flow

```
Browser                  Next.js API              R2                     Postgres
   │                          │                    │                         │
   │  POST .../photos/init    │                    │                         │
   │  {filename, mime, size}  │                    │                         │
   ├─────────────────────────►│  check member      │                         │
   │                          │  validate MIME     │                         │
   │                          │  declared size ≤25M│                         │
   │                          │  SELECT events FOR UPDATE                    │
   │                          │  count photos      ├────────────────────────►│
   │                          │  ◄── ok? ─────────────────────────────────── │
   │                          │  INSERT photos    {state='pending', uploaderUserId=caller, eventId, pendingKey}
   │                          ├─────────────────────────────────────────────►│
   │                          ├──── presign  ─────►│                         │
   │ ◄──{photoId, putUrl}─────┤                    │                         │
   │                          │                    │                         │
   │  PUT bytes               │                    │                         │
   ├──────────────────────────┼───────────────────►│                         │
   │                          │                    │                         │
   │  POST .../finalize       │                    │                         │
   ├─────────────────────────►│  SELECT photos by id                         │
   │                          ├─────────────────────────────────────────────►│
   │                          │  ◄── row ───────────────────────────────────│
   │                          │  assert row.uploaderUserId === caller        │
   │                          │  HEAD pending/    │                         │
   │                          ├───────────────────►│                         │
   │                          │  ◄── content-length, abort if >25 MB         │
   │                          │  GET pending/      │                         │
   │                          ├───────────────────►│                         │
   │                          │  ◄────  bytes  ─────                         │
   │                          │  Sharp pipeline:                             │
   │                          │   decode → rotate → extract EXIF             │
   │                          │   q=95 JPEG + q=85 2048px JPEG               │
   │                          │  PUT original/, preview/                     │
   │                          ├───────────────────►│                         │
   │                          │  DELETE pending/   │                         │
   │                          ├───────────────────►│                         │
   │                          │  UPDATE photos SET state='ready', uploadedAt=now(), r2Key*, width, height, takenAt
   │                          ├─────────────────────────────────────────────►│
   │ ◄────{photo: {...}}──────┤                    │                         │
```

**Browser orchestration:** Fixed concurrency = 3. `Promise.all` over batches; each file does init → PUT → finalize as one async unit. Aggregate progress = `done / total` after each file completes.

---

## Error handling

**Init validation (in order, fail-fast):**
1. Authenticated → else 401.
2. Member of event → else 403.
3. Event not expired → else 410 Gone.
4. MIME ∈ allowlist → else 400.
5. Declared size ≤ 25 MB → else 413.
6. **Inside `BEGIN`:** `SELECT 1 FROM events WHERE id=$1 FOR UPDATE` (locks the parent row); count `WHERE event_id=$1 AND deleted_at IS NULL`; if count ≥ 5000 → 429 + `ROLLBACK`. Otherwise `INSERT INTO photos … 'pending'` and `COMMIT`. Two concurrent inits at the boundary serialize on the same locked event row.

**Finalize validation:**
1. Authenticated → else 401.
2. `SELECT photos WHERE id=$1` → 404 if missing.
3. `row.uploaderUserId === currentUser.id` → else 403 (closes IDOR; even if the photoId is guessed, only the original uploader can finalize).
4. `row.processingState === 'pending'` → else if `'ready'` return existing row (idempotent); else 409.
5. `HEAD events/<eventId>/pending/<photoId>.bin` → 404 if missing (was lifecycle-purged), set `state='failed'`, return 410.
6. `Content-Length ≤ 25 MB` → else set `state='failed'`, delete pending, return 413.

**Sharp failure:**
- Any exception → set `state='failed'`, delete pending, return 422.

**Cap race (deeper):** Wrapped above. The `events FOR UPDATE` lock guarantees only one init at a time per event holds the lock; counting after the lock and inserting before release is correctly serialized. Two-phase concern is fully resolved.

**Orientation:** `sharp(...).rotate()` (no args) auto-rotates per EXIF and strips the tag. Both objects render upright everywhere.

**Read-path errors (preview/original):** `GET /api/photos/:id/preview` returns 401/403/404; never leaks key existence (404 for both "not found" and "not a member").

**Out of scope for Phase 2:**
- Resumable uploads — Phase 6 if attendees complain.
- Same-photo-uploaded-twice dedup — Phase 5+.
- Content moderation.
- Animated GIFs (`image/gif` not on allowlist).
- General-visibility gallery ("Open Pool" / "Host-only" / Personal cross-uploader views) — Phase 5.

---

## Phase 2 read surface (deliberately narrow)

Only the **uploader-only "By Me" view** ships in Phase 2:

`GET /events/:id/photos` (page) — server component, filters:
```sql
SELECT * FROM photos
WHERE event_id = $1
  AND uploader_user_id = $currentUser
  AND processing_state = 'ready'
  AND deleted_at IS NULL
ORDER BY taken_at DESC NULLS LAST, created_at DESC
```

The gallery renders thumbnails as `<img src="/api/photos/<id>/preview">`. Each request does a fresh membership check. No bypass.

This is the minimum view that's both useful (uploader sees their uploads land) and privacy-safe (no cross-uploader exposure before face matching ships). Phase 5 builds the You / By Me / Other tabs on top of this same plumbing.

---

## Testing

**Unit (Vitest, no DB, no R2):**
- `lib/photos/process.ts` — `processImage(buffer): {originalJpeg, previewJpeg, width, height, takenAt}`. Tests: JPEG round-trip, HEIC→JPEG conversion, EXIF orientation rotation, orientation tag stripped, GPS dropped, `DateTimeOriginal` extraction, corrupt input throws typed error.
- `lib/photos/r2.ts` — wraps `@aws-sdk/client-s3`. Mocked S3 client; assert correct bucket/key/body passed.

**Test fixtures:** `tests/setup-fixtures.ts` runs once before tests; generates 4 small images via Sharp (plain JPEG, HEIC built from it, JPEG with EXIF orientation=6, JPEG with GPS in EXIF). Output to `tests/fixtures/photos/`. Fixture dir in `.gitignore` — regenerated each run.

**Integration (Vitest + Docker test DB, R2 mocked at module level):**
- `init` route — happy path + 401, 403, 410, 400, 413, 429. Concurrency stress test on 5000-cap boundary (10 parallel inits, exactly 5000 succeed, others get 429).
- `finalize` route — happy path inserts/updates row + uploader check returns 403 + idempotent re-call returns same row + size cap exceeded post-PUT returns 413 + Sharp failure returns 422.
- `GET /api/photos/:id/preview` — 401, 403 (non-member), 404 (missing), 200 + correct bytes for member.
- S3 client faked via `vi.mock` pointing at an in-memory `Map<key, Buffer>`.

**E2E (Playwright):**
- Seed host via test-only `/api/test/sign-in-as` route (`NODE_ENV === 'test'` guarded), navigate to `/events/:id`, upload 3 fixture images, assert "By Me" view shows 3 thumbnails.
- `webServer` env extended with `R2_*` pointing at a dedicated test bucket.

**Skipping:** load testing, quota-exhaustion drills.

---

## What's done by end of Phase 2

- Migration `0004_*_add_photos.sql` applied to Supabase + Docker.
- R2 bucket configured **private** with `events/{eventId}/pending/` lifecycle rule + CORS allowing localhost origins. No public dev URL.
- `lib/photos/process.ts`, `lib/photos/r2.ts` with full test coverage.
- `/api/events/:id/photos/init`, `/api/events/:id/photos/:photoId/finalize` — TDD'd.
- `/api/photos/:photoId/preview`, `/api/photos/:photoId/original` — auth-checked streaming routes.
- Upload UI on `/events/[id]` page (host + attendee). Drag-and-drop, multi-select, batch-of-3, aggregate progress.
- "By Me" gallery on the same page: thumbnails sorted by `taken_at desc nulls last, created_at desc`.
- Playwright e2e covering full upload happy path + thumbnail render.
- Docs/README updated.

What's intentionally **not** in Phase 2 (Phase 3+):
- Face detection / embedding worker — Phase 3.
- General-visibility gallery (You / By Me / Other) and visibility-mode enforcement — Phase 5.
- Per-photo download UI for non-uploaders — Phase 5.
- Bulk download — Phase 5.
- Email notifications on new uploads — Phase 6.
- Cleanup of `failed` rows + their R2 objects — Phase 6.

---

## Review changes (2026-04-29)

Codex review surfaced 8 issues. All addressed in this revision:

1. **Critical — undefined private read path:** Added decision #8 (private bucket + auth-checked Next.js streaming routes for preview/original) and made gallery `<img>` src point at those routes.
2. **Critical — IDOR / upload hijack:** Decision #9 (insert `photos` row at init time) plus finalize step 3 (uploader binding check).
3. **Important — re-encoding source contradicts product design:** User decision (2026-04-29) to keep JPEG normalization; product design line 25 effectively overridden, noted in decision #3.
4. **Important — no processing state:** Added `processingState` column with three states and an index.
5. **Important — claimed PUT size not enforced:** Added `HEAD` step in finalize before download, with abort + state='failed' on overrun.
6. **Important — cap race underspecified:** Init now runs inside a transaction with `SELECT events FOR UPDATE` before counting/inserting.
7. **Important — gallery scope ambiguous:** Phase 2 read surface restricted to uploader-only "By Me." Full visibility-mode gallery moved to Phase 5 explicitly.
8. **Important — schema gaps:** Added `uploadedAt`, `deletedAt`, `originalFilename`, `declaredMimeType`, `declaredSizeBytes`. Storage keys event-scoped (`events/<eventId>/...`).

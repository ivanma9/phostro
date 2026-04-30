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
| 8 | **Private R2 bucket.** No public dev URL. Preview URLs minted as 5-min presigned GETs at gallery render time and embedded in HTML. Originals served via `/api/photos/:id/original` route that checks `caller is uploader` (Phase 2) and 302-redirects to a freshly-minted 5-min presigned GET. | Required by product design line 26 (Personal mode default). Render-time presigning avoids per-image serverless invocations. |
| 9 | **Photos row created at `init` time**, not at finalize | Binds `photoId` to uploader + event at the moment of presigned-URL minting. Closes IDOR / upload-hijack window. |

---

## Architecture

**Stack additions:**
- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — R2 access (S3-compatible).
- `sharp` — JPEG/HEIC decode, resize, re-encode.
- `exifr` — lightweight EXIF reader for `DateTimeOriginal`.
- Node runtime on photo routes (`export const runtime = 'nodejs'`).

**Three write API routes:**
1. `POST /api/events/:id/photos/init` — validates membership, MIME, declared size, event cap (with row lock). **Inserts a `photos` row** with `processingState='pending'` and `pendingExpiresAt = now() + 24h`. Returns presigned PUT URL pointing at `events/<eventId>/pending/<photoId>.bin`.
2. Browser uploads bytes directly to R2 via presigned URL. App-server bandwidth = zero.
3. `POST /api/events/:id/photos/:photoId/finalize` — loads the `photos` row, **verifies the row's `uploaderUserId` matches the caller** (closes IDOR), rejects rows whose `pendingExpiresAt < now()` early (returns 410, sets `state='failed'`), then **atomically claims** the row including stale-claim reclaim: `UPDATE photos SET processingState='processing', processingClaimedAt=now() WHERE id=$1 AND (processingState='pending' OR (processingState='processing' AND processingClaimedAt < now() - interval '5 minutes')) RETURNING *`. If the claim returns nothing, branch on observed state. After claim: HEADs the pending object to enforce real size, fetches it, runs Sharp, writes original/preview, deletes pending, sets `processingState='ready'` + clears `processingClaimedAt`/`pendingExpiresAt` + final metadata.

**Read path (no streaming through Next.js):**

Gallery rendering uses **presigned GET URLs minted at server-component render time**, with 5-minute TTL. The server component runs the gallery query (uploader-only in Phase 2), and for each `ready` row it generates a presigned URL pointing at `preview/<id>.jpg`. URLs go straight into the HTML as `<img src="https://<bucket>.r2.cloudflarestorage.com/...?X-Amz-Signature=...">`. The browser fetches each preview directly from R2; no per-image serverless invocation, no R2 bandwidth through us.

Auth: enforced once, at render-time DB query. Non-uploaders never see URLs in their HTML at all (their gallery returns zero rows).

For per-photo download (Phase 5 surface, but the route ships in Phase 2 for the uploader's "By Me" download button):

4. `GET /api/photos/:photoId/original` — checks `caller is uploader` (Phase 2; Phase 5 broadens with visibility-mode rules), 302-redirects to a freshly-minted 5-minute presigned GET URL. One serverless invocation per click — fine, low frequency.

**Why presigned-at-render, not stream-through-Next.js:**
- 1000 photos × 50 attendees on the gallery page = 50K serverless invocations + bandwidth per browse session if we streamed. Vercel free tier is 100K invocations/mo total. Cliff in weeks.
- Presigned-at-render: one render per page load (≤1 invocation per attendee), zero R2 bandwidth through us, browser cache works because the URL is stable for 5 minutes.
- Trade-off: a presigned URL leaked within its 5-min window grants the photo to anyone. Acceptable — same trust boundary as the attendee screenshotting and sharing the photo themselves.

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

    // State machine. 'pending' inserted at init; 'processing' atomically
    // claimed by finalize; 'ready' on successful finalize; 'failed' on
    // Sharp error / size cap exceeded post-PUT.
    processingState: text('processing_state', {
      enum: ['pending', 'processing', 'ready', 'failed'],
    })
      .notNull()
      .default('pending'),

    // Pending row expiry — mirrors R2 lifecycle; Phase 6 cleanup deletes
    // rows where state='pending' and pendingExpiresAt < now().
    pendingExpiresAt: timestamp('pending_expires_at'),  // set at init, cleared on finalize

    // Stale-claim reclaim. Set when state→'processing'; finalize allows
    // re-claiming rows whose claimedAt is older than 5 minutes (the function
    // crashed mid-Sharp). Cleared when state→'ready' or 'failed'.
    processingClaimedAt: timestamp('processing_claimed_at'),

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
- Four states: `pending` (init done, awaiting bytes / Sharp), `processing` (finalize has atomically claimed, Sharp running), `ready` (gallery-visible), `failed` (terminal error). Failed rows stay for debugging; cleanup deletes them in Phase 6.
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
   │                          │  ATOMIC CLAIM:                               │
   │                          │  UPDATE photos SET state='processing'        │
   │                          │   WHERE id=$1 AND state='pending' RETURNING *│
   │                          ├─────────────────────────────────────────────►│
   │                          │  if no row returned → idempotent branch      │
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
   │                          │  UPDATE photos SET state='ready', uploadedAt=now(), r2Key*, width, height, takenAt, pendingKey=NULL, pendingExpiresAt=NULL
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
6. **Inside `BEGIN`:** `SELECT 1 FROM events WHERE id=$1 FOR UPDATE` (locks the parent row); count rows that genuinely consume the event quota:
   ```sql
   SELECT count(*) FROM photos
   WHERE event_id=$1
     AND deleted_at IS NULL
     AND (
       processing_state IN ('ready', 'processing')
       OR (processing_state = 'pending' AND pending_expires_at > now())
     )
   ```
   Expired pending rows are deliberately excluded — they're tombstones awaiting Phase 6 cleanup, not real uploads. If count ≥ 5000 → 429 + `ROLLBACK`. Otherwise `INSERT INTO photos … 'pending'` with `pendingExpiresAt = now() + interval '24 hours'` and `COMMIT`. Two concurrent inits at the boundary serialize on the same locked event row.

**Finalize validation:**
1. Authenticated → else 401.
2. `SELECT photos WHERE id=$1` → 404 if missing.
3. `row.uploaderUserId === currentUser.id` → else 403 (closes IDOR; even if the photoId is guessed, only the original uploader can finalize).
4. **Pending TTL check:** if `row.pendingExpiresAt < now()` AND `row.processingState IN ('pending', 'processing')` → set `state='failed'`, return 410 with body `{ status: 'expired' }`. R2 lifecycle has either already deleted the pending object or will soon; we don't want to chase a doomed upload.
5. **Atomic claim with stale-reclaim:**
   ```sql
   UPDATE photos SET processing_state='processing', processing_claimed_at=now()
   WHERE id=$1
     AND (
       processing_state='pending'
       OR (processing_state='processing' AND processing_claimed_at < now() - interval '5 minutes')
     )
   RETURNING *
   ```
   - If a row is returned: caller owns processing, continue to step 6. Stale-reclaim handles the case where a previous finalize crashed/timed out and left the row stranded — after 5 minutes (longer than any realistic Sharp run on Vercel's max function timeout of 60s), retries can succeed instead of being permanently stuck at 409.
   - If no row is returned: re-read by id and branch on observed state:
     - `processing` (with recent `processingClaimedAt`) → another finalize is actively running; return 409 with body `{ status: 'processing', retryAfterSeconds: 30 }`.
     - `ready` → idempotent success: return existing row, 200.
     - `failed` → return 422 with body `{ status: 'failed' }`.
     - `pending` (impossible after the UPDATE — would have matched the claim) → treat as 500.
6. `HEAD events/<eventId>/pending/<photoId>.bin` → 404 if missing (was lifecycle-purged), set `state='failed'`, return 410.
6. `Content-Length ≤ 25 MB` → else set `state='failed'`, delete pending, return 413.

**Sharp failure:**
- Any exception → set `state='failed'`, delete pending, return 422.

**Cap race (deeper):** Wrapped above. The `events FOR UPDATE` lock guarantees only one init at a time per event holds the lock; counting after the lock and inserting before release is correctly serialized. Two-phase concern is fully resolved.

**Orientation:** `sharp(...).rotate()` (no args) auto-rotates per EXIF and strips the tag. Both objects render upright everywhere.

**Read-path errors (per-photo download):** `GET /api/photos/:id/original` returns 401/403/404; in Phase 2 caller must be `row.uploaderUserId` (host/visibility-mode broadening is Phase 5). Returns 404 for both "not found" and "uploader mismatch" — no existence oracle. There is no `/preview` route — preview URLs are presigned at gallery render time and embedded in HTML; non-uploaders never see them.

**Pending / stranded row leftover:** A row stuck in `state='pending'` after 24h (browser crashed, finalize never came) — or stranded in `processing` because a finalize crashed mid-Sharp — is handled in two ways:
- **In Phase 2:** finalize's TTL check (validation step 4) fails-fast on expired rows; the atomic claim's stale-reclaim clause (step 5) lets retries take over `processing` rows older than 5 min. So in practice, a user retrying upload of a stranded photo recovers automatically.
- **In Phase 6:** a daily cron does the bulk cleanup: `DELETE FROM photos WHERE processing_state IN ('pending', 'processing') AND pending_expires_at < now()`. The cap-count query (init step 6) already excludes expired pending rows, so cap pressure from stale rows is bounded to 24h × upload rate even before the cron runs.

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

The server component runs the query above, then for each row generates a 5-minute presigned GET URL pointing at `preview/<id>.jpg`. URLs are embedded directly: `<img src="https://<bucket>.r2.cloudflarestorage.com/...?X-Amz-Signature=...">`. Browser fetches each preview straight from R2 — zero serverless invocations, zero R2 bandwidth through us per image. Non-uploaders' gallery query returns no rows, so no URLs are ever minted for them.

The "Download original" button on each photo points at `/api/photos/<id>/original`, which auth-checks (uploader-only in Phase 2) and 302-redirects to a freshly-minted 5-minute presigned GET URL.

This is the minimum view that's both useful (uploader sees their uploads land) and privacy-safe. Phase 5 reuses the presigned-at-render pattern: the gallery query expands to include matched photos / uploader's photos / "no people" photos per the visibility mode, and the rest of the plumbing (URL minting, embedding) stays identical.

---

## Testing

**Unit (Vitest, no DB, no R2):**
- `lib/photos/process.ts` — `processImage(buffer): {originalJpeg, previewJpeg, width, height, takenAt}`. Tests: JPEG round-trip, HEIC→JPEG conversion, EXIF orientation rotation, orientation tag stripped, GPS dropped, `DateTimeOriginal` extraction, corrupt input throws typed error.
- `lib/photos/r2.ts` — wraps `@aws-sdk/client-s3`. Mocked S3 client; assert correct bucket/key/body passed.

**Test fixtures:** `tests/setup-fixtures.ts` runs once before tests; generates 4 small images via Sharp (plain JPEG, HEIC built from it, JPEG with EXIF orientation=6, JPEG with GPS in EXIF). Output to `tests/fixtures/photos/`. Fixture dir in `.gitignore` — regenerated each run.

**Integration (Vitest + Docker test DB, R2 mocked at module level):**
- `init` route — happy path + 401, 403, 410, 400, 413, 429. Concurrency stress test on 5000-cap boundary (10 parallel inits, exactly 5000 succeed, others get 429).
- `finalize` route — happy path transitions `pending→processing→ready` + uploader check returns 403 + atomic-claim race (two parallel finalize calls: one wins with 200, the other gets 409 `{status:'processing'}` or idempotent `{status:'ready'}`) + size cap exceeded post-PUT returns 413 + Sharp failure leaves row in `failed`.
- `GET /api/photos/:id/original` — 401, 403 (non-uploader), 404 (missing or wrong uploader — same response), 302 with valid presigned Location for uploader.
- Gallery server component — generates correct number of presigned URLs (= row count); URLs are valid for 5 min; non-uploader's HTML contains zero photo URLs.
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
- `/api/photos/:photoId/original` — auth-checked 302-redirect to short-lived presigned GET URL (uploader-only in Phase 2).
- Server-component-side preview URL minting (5-min presigned GET URLs embedded in gallery HTML).
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
- **Init idempotency keys** — explicitly deferred. Phase 2 accepts that a browser-retried `init` may consume two slots against the cap until the orphan's `pendingExpiresAt` passes. Mitigations already in place: cap-count query excludes expired pending rows, finalize's stale-reclaim auto-recovers `processing` rows, and the upload UI's batched concurrency makes retries rare. Add idempotency keys in Phase 6 if real-world retry rates make the cap leak material.

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

## Review changes (round 2, 2026-04-30)

Codex round-2 review surfaced 4 follow-on issues from the round-1 fixes. All addressed:

1. **Phase 2 read auth was broader than gallery scope.** Read route checked event-membership while gallery only showed uploader's own photos — an attendee could enumerate `/api/photos/:id/preview` for other attendees' uploads. **Fix:** dropped the `/preview` route entirely (see #4 below). The remaining `/api/photos/:id/original` route now requires `caller is uploader` in Phase 2; Phase 5 broadens.
2. **Finalize race could overwrite `ready` with `failed`.** Two concurrent finalize calls both passed `state='pending'` and ran Sharp; the loser could overwrite the winner. **Fix:** added atomic claim — `UPDATE … SET state='processing' WHERE id=$1 AND state='pending' RETURNING *`. Added `'processing'` as a fourth state. Idempotent re-finalize branches on observed state (processing → 409, ready → 200, failed → 422).
3. **No pending-row TTL or cleanup path.** **Fix:** added `pendingExpiresAt` column (= createdAt + 24h, mirroring R2 lifecycle). Documented Phase 6 cleanup query. Init idempotency keys deferred (YAGNI for MVP — UI's batch-of-3 retry is fine).
4. **Streaming previews through Next.js was a cost cliff.** 50K+ serverless invocations per browse session at moderate scale. **Fix:** dropped `/api/photos/:id/preview` route. Server component now mints 5-minute presigned GET URLs at gallery render time and embeds them directly in `<img src>`. Browser fetches each preview straight from R2. Auth happens once (at the gallery DB query) — non-uploaders' HTML contains zero photo URLs. Trade-off: a presigned URL leaked within its 5-min window grants the photo, equivalent to the attendee screenshotting and sharing.

## Review changes (round 3, 2026-04-30)

Codex round-3 review found 1 new Important and 3 partial-resolutions from round 2. All addressed:

1. **NEW Important: stuck `processing` state after crash/timeout.** A finalize that died after the atomic claim left the row stranded in `processing`; retries got `409 {status:'processing'}` permanently. **Fix:** added `processingClaimedAt` column. Atomic claim now reclaims rows whose claim is older than 5 minutes — longer than any realistic Sharp run on Vercel's max function timeout. Stranded rows self-heal on the next user retry.
2. **Decision #8 wording was internally inconsistent** — still said "preview and original served through Next.js routes" after we dropped /preview. **Fix:** updated to describe presigned-at-render previews + 302-redirect for originals.
3. **Cap-count query counted expired pending rows**, letting an event hit 5000 cap with stale tombstones. **Fix:** init's count query now filters `processing_state IN ('ready', 'processing') OR (state='pending' AND pending_expires_at > now())`. Expired pending rows don't pressure the cap.
4. **No early rejection of expired pending in finalize.** Finalize would proceed into Sharp work on rows whose R2 pending object had been lifecycle-purged. **Fix:** added validation step 4 that returns 410 + sets `state='failed'` if `pendingExpiresAt < now()`.
5. **Init idempotency keys**: explicitly deferred to Phase 6 with a paragraph in the "Out of scope" section explaining the mitigations already in place.

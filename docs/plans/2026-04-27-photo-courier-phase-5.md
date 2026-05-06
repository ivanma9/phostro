# Photo Courier — Phase 5: Gallery + Download

> **⚠ Deferred — host-broadcast product line.** Active development is on **Pocket v0 / v1** (receiver-pooled product). See `docs/plans/2026-05-02-pocket-v0-implementation.md`. This phase plan is preserved for **Pocket Platform v2** — the original host-broadcast model — which is on hold pending Pocket v0 self-use results. Do not execute tasks here without re-confirming the product direction. Salvageable subsets for Pocket v1 are noted at the end of this document.

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Date:** 2026-04-27
**Status:** Draft, ready for execution after Phase 4 review checkpoint passes
**Source plans:**
- Design: `docs/plans/2026-04-26-photo-courier-design.md` (esp. "Visibility modes & gallery UX", "Diff-download UX")
- Implementation roadmap: `docs/plans/2026-04-27-photo-courier-implementation.md` (Phase 5 outline at lines 1338-1349)
- Codex roadmap: `docs/plans/2026-04-27-photo-courier-implementation-codex.md` (Milestone 5)
- Device protocol: `docs/milestone-0-device-test-protocol.md` (Section 4 is load-bearing for this phase)

---

## End state of Phase 5

After Phase 5, an enrolled attendee opening an event gallery sees:

1. A three-tab gallery — **You**, **By Me**, **Other** — with Personal-mode authorization enforced at the query layer (no `open_pool` / `host_only` UX wired; schema rows untouched).
2. A diff-download header per tab: "23 photos of you · 5 new since Tuesday" derived from server-side `photo_saves`.
3. A bulk-save action whose default is "Save N new" (toggle to "Save all"), with platform-aware behavior:
   - Anchor-loop for batches at or below `BULK_SAVE_ZIP_THRESHOLD` (configurable, default 20, **locked after Milestone 0 device tests**).
   - ZIP download for batches above threshold, generated on demand and streamed.
   - iOS Safari guidance copy when the install-PWA path materially improves the save flow (per device-test results).
4. Per-photo "saved" affordance (subtle checkmark) backed by `photo_saves` rows.
5. Empty states ("All caught up") on every tab.
6. Performant rendering at >200 photos via cursor pagination (50 per page) plus `IntersectionObserver`-driven infinite scroll.
7. A "By Me" tab that respects the Personal-mode privacy posture: an uploader always sees their own uploads regardless of whether they appear in those photos, and regardless of which other attendees are or are not enrolled.
8. A host-side rendering path: in Personal mode, the host sees the same three tabs but the queries return all event photos (host privilege), not just face-matched ones.

Not in scope: notifications, host archive ZIP, expiry cron — those are Phase 6.

---

## Exit criteria

Phase 5 is done when **all** of the following hold and are verifiable by automated tests or recorded manual smoke runs:

1. **Schema migrated.** `photo_views` and `photo_saves` tables exist in Postgres with `(user_id, photo_id)` primary keys and `viewed_at` / `saved_at` timestamps. Migration runs cleanly in CI against pgvector image.
2. **Three tabs render correct contents under Personal mode.** Integration tests cover: (a) user A appears in 3 photos of which they uploaded 1, expects 3 in You, 1 in By Me, 0 dupes when "Save all" is computed across tabs; (b) user B uploaded 2 photos of which they appear in 0, expects 0 in You, 2 in By Me; (c) Other tab returns only photos with `has_detected_faces = false`.
3. **Diff math is correct.** Given a user with `photo_saves` rows for 18 of 23 matched photos and `saved_at` cutoff before Tuesday, the gallery header reads "23 photos of you · 5 new since Tuesday" and "Save 5 new" downloads exactly those 5.
4. **Already-saved indicator.** Per-photo UI shows a check on photos with a `photo_saves` row for the current user.
5. **Bulk save respects platform.** Given `BULK_SAVE_ZIP_THRESHOLD = 20`: a batch of 5 uses anchor loop; a batch of 50 triggers ZIP download. Threshold reads from `process.env.BULK_SAVE_ZIP_THRESHOLD` with documented default. Both paths verified manually on at least one iOS Safari, one iOS PWA, and one Android Chrome device, with results pasted into the device-protocol section 4 table.
6. **Threshold lock-in is documented.** After device tests are run during this phase, the chosen value of `BULK_SAVE_ZIP_THRESHOLD` is recorded in `docs/plans/decisions.md` (or appended to `docs/milestone-0-device-test-protocol.md` Section 5) with date and tester sign-off.
7. **Gallery paginates above 200 photos.** Loading an event with 250 seeded photos returns the first 50 within 300 ms server time; subsequent pages load via infinite scroll without re-querying earlier pages. Verified by Playwright fixture.
8. **By Me tab privacy contract.** A user who uploaded a photo containing only other attendees still sees that photo in By Me; those other attendees do not see it in their You unless they appear in it and are enrolled. Verified by integration test.
9. **No `open_pool` / `host_only` UX leaks.** Code that branches on `event.visibility_mode` exists only at the query layer, returns 501 / falls back to Personal behavior for the other modes, and a unit test asserts no UI tab labeled "All" renders even if a row's `visibility_mode` is hand-edited to `open_pool`.
10. **Authorization is enforced server-side, not in the UI.** A user manually requesting a photo ID they should not see (not a face match, not their upload, not Other-bucket) gets 403 from the photo-fetch route. Integration test required.
11. **Host's full-pool view works.** Host on a Personal-mode event sees all photos across the three tabs (queries skip the `claimed_by_user_id = me` filter for the host role). Test required.
12. **Phase 5 review checkpoint signed off.** `superpowers:requesting-code-review` invocation produces no Critical / Important issues, or remaining ones are explicitly accepted.

---

## Explicitly deferred — not in Phase 5

Do not implement or unblock these. They belong to Phase 6 or v1.1.

- **Notifications.** No "5 new photos of you" email triggered from `photo_saves` deltas. The data is collected; the dispatcher is Phase 6.
- **`open_pool` and `host_only` visibility UI.** Schema columns are honored only by Personal-mode logic. The "All" tab does not render. Authorization for the other modes is **not** wired.
- **Host archive / event ZIP export.** Host-side bulk download of the entire event into a single archive is an attendee-flow ZIP, not a host-flow archive job. Phase 6.
- **Per-photo "Share with event" override.** v1.1.
- **Push notifications, in-app activity feed, "Sarah just added 12 photos."** Phase 6 / v1.1.
- **Save-state across devices in real time.** A user who saves on phone sees the check on desktop only after refresh. WebSocket / SSE not needed for MVP.
- **Re-running matching on already-uploaded photos when a new user enrolls.** Phase 4 / Phase 6 question. Phase 5 reads cluster results as it finds them.
- **Heuristic dedupe.** Identical photos uploaded twice show twice. v1.1.
- **Video.** Photos only (per locked decision in implementation doc).
- **Native iOS / Android share-sheet integration.** Best-effort `<a download>` is the MVP surface.
- **Service-worker offline gallery.** v1.1.

---

## Open questions

These are flagged for resolution **inside** Phase 5 (early tasks) or escalated to product if they block.

1. **ZIP threshold (N)** — default 20 in code, but the **definitive value is set after Section 4 of the device-test protocol is run**. If the protocol has not been executed when Phase 5 begins, Task 0 forces it. Threshold is locked into `docs/plans/decisions.md` at end of phase.
2. **ZIP generation location.** Three options: (a) Next.js API route streams a ZIP using `archiver` (Node), (b) Python worker generates ZIP and returns presigned URL, (c) client-side `jszip` after fetching all photos. Recommendation in Task 6: (a) for simplicity, with a 5-minute timeout and presigned-URL fallback if request exceeds Vercel function limits. **Decided in Task 6 after spike; record outcome.**
3. **Save-state persistence model.** Design doc's `PhotoSave (user_id, photo_id, saved_at)` reads as one row per pair (aggregate). Plan adopts this — `saved_at` is "most recent save initiation," and re-saving updates the timestamp via upsert. **No append-only save history.** Rationale cited inline in Task 1.
4. **Host's "You" tab in Personal mode.** Does the host see their own face matches, or all photos (because host sees everything)? Plan: host sees **all** photos in You (treating host as if they're in every photo) — keeps the host's mental model consistent with "I see the whole event." Confirm with product before Task 4 ships.
5. **"By Me" includes photos the uploader appears in twice.** A photo I uploaded that I'm also in: appears in both You and By Me. Bulk "Save all (You)" + "Save all (By Me)" must dedupe before save. Resolved in Task 5.
6. **Cursor pagination key.** `(uploaded_at DESC, photo.id DESC)` as a stable composite cursor. Confirmed in Task 7.

If any of 1, 2, or 4 cannot be resolved by the time their task is reached, stop and escalate. Items 3, 5, 6 have defaults specified.

---

## Cross-phase contracts assumed

Phase 5 depends on:

- **From Phase 1:** `users`, `events`, `event_members`, signed-cookie sessions, `getCurrentUser()`, the `(app)` route group.
- **From Phase 2:** `photos` table with `event_id`, `uploader_user_id`, `r2_key_original`, `r2_key_preview`, `width`, `height`, `taken_at`, `uploaded_at`, `has_detected_faces`. Presigned-GET URL helper for downloads. Photo-fetch authorization helper (`canUserSeePhoto(userId, photoId)`) **may** be added here if Phase 2 didn't ship one — Task 4 owns it if missing.
- **From Phase 3:** `face_detections`, `face_clusters` populated for processed photos; `Photo.has_detected_faces` set by the worker after detection (drives Other tab).
- **From Phase 4:** Matching is provided via two concrete surfaces shipped by Phase 4:
  - `user_event_matches` table with columns `(user_id, event_id, cluster_id, score, band)` populated by Phase 4's matching pipeline at enrollment and on every `GET /api/events/:id/my-matches` call.
  - `GET /api/events/:id/my-matches` endpoint that reads/upserts `user_event_matches` and returns banded results.
  Phase 5's "You" tab joins photos against `user_event_matches` filtered by `band='match'`; the `'maybe_you'` band is rendered as a subdued sub-section under the You tab. No contract probe or fallback join is needed — the table is the contract.
- **From Phase 4:** `users.face_embedding` (or `face_profile`) is non-null for enrolled users. Phase 5 uses an `isEnrolled(user)` predicate to gate the You-tab CTA.

Phase 5 produces (consumed by Phase 6):

- `photo_views` and `photo_saves` tables — Phase 6's notification dispatcher reads `photo_saves` deltas to compute "X new photos of you" emails.
- `BULK_SAVE_ZIP_THRESHOLD` env var documented for production deploys.
- A `lib/gallery/diff.ts` module exposing `getNewSinceLastSave(userId, eventId, tab)` that Phase 6 may reuse.

Phase 6 cleanup affects Phase 5:

- The expiry cron deletes `photos` rows. `photo_views` and `photo_saves` use `ON DELETE CASCADE` against `photos` and `users`, so cleanup needs no Phase-5-specific work.
- The "Photos expire in 48 hours" banner is Phase-6-rendered but **mounts inside the gallery layout shipped in Phase 5** — Task 4 leaves a `<ExpiryBannerSlot />` placeholder.

---

## Tasks

### Task 0: Gate on Milestone 0 Section 4 device tests

**Files:** none modified; this is a procedural gate.

**Steps:**
1. Open `docs/milestone-0-device-test-protocol.md` Section 4 (Bulk Save) and Section 5 (Decisions).
2. Confirm at minimum the 10-photo and 50-photo rows in tables 4a and 4b are filled in for: iOS Safari, iOS PWA, Android Chrome.
3. Confirm Section 5 row "What is the practical bulk-save limit on iOS without triggering dialog fatigue?" has an answer.
4. If any of the above are blank: **stop Phase 5**. Schedule the device-test session. Do not start Task 1 until results land.
5. If filled in: extract the practical iOS dialog-fatigue threshold and propose it as the seed value for `BULK_SAVE_ZIP_THRESHOLD` (call this seed `N_seed`). Default to 20 if data is ambiguous.
6. Record `N_seed` in this file's task log (or in commit message of Task 1).

**Expected output:** A go/no-go decision and a numeric `N_seed`.

**Verification:** Reviewer confirms protocol section is filled in before approving Task 1's PR.

---

### Task 1: Schema — `photo_views` and `photo_saves`

**Files:**
- Modify: `db/schema.ts`
- Generate: `db/migrations/00XX_photo_views_saves.sql` (via `pnpm db:generate`)

**Steps:**
1. Add `photo_views` table:
   ```ts
   export const photoViews = pgTable('photo_views', {
     userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
     photoId: uuid('photo_id').notNull().references(() => photos.id, { onDelete: 'cascade' }),
     viewedAt: timestamp('viewed_at').notNull().defaultNow(),
   }, (t) => ({ pk: primaryKey({ columns: [t.userId, t.photoId] }) }))
   ```
2. Add `photo_saves` table with the same shape but `savedAt`. **One row per (user, photo) pair** — re-saving upserts and refreshes `savedAt`. This matches the design doc's `PhotoSave (user_id, photo_id, saved_at)` declaration and is sufficient for the "5 new since Tuesday" UX (we compare `savedAt` to a cutoff or compute set-difference against unsaved photos).
3. Add a comment in the schema file noting that `photo_saves` is **not** an append-only history; if Phase 6 ever needs save history (e.g., audit trail), it should add a separate `photo_save_events` table rather than reshape this one.
4. `pnpm db:generate && pnpm db:migrate`.
5. Verify in Drizzle Studio.

**Expected output:** Two new tables, migration committed.

**Verification:**
- Migration applies cleanly in CI (pgvector image).
- A trivial integration test inserts one row in each table and reads it back.

**Commit:** `feat(db): add photo_views and photo_saves tables`

---

### Task 2: Read matched photos via `user_event_matches`

**Files:**
- Create: `lib/gallery/matched-photos.ts`.
- Create: `tests/gallery/matched-photos.test.ts`.

Phase 4 ships the `user_event_matches` table `(user_id, event_id, cluster_id, score, band)` and populates it at enrollment and via `GET /api/events/:id/my-matches`. No contract probe is needed — the table is the stable contract.

**Steps:**
1. Implement `lib/gallery/matched-photos.ts` exposing `getMatchedPhotoIds(userId, eventId): Promise<string[]>` using the following join:
   ```sql
   SELECT DISTINCT p.id
   FROM photos p
   JOIN face_detections fd ON fd.photo_id = p.id
   JOIN user_event_matches uem ON uem.cluster_id = fd.cluster_id
   WHERE uem.user_id = $1
     AND uem.event_id = $2
     AND uem.band = 'match'
   ```
   The `'maybe_you'` band is intentionally excluded here; Task 3's `getYouTabPhotos` surfaces `maybe_you` rows as a subdued sub-section using a parallel `getMaybeYouPhotoIds` variant of the same join with `band = 'maybe_you'`.
2. Write a fixture-based unit test using a seeded test DB: 1 user, 1 event, 3 photos, 2 `user_event_matches` rows (one `band='match'`, one `band='maybe_you'`), assert `getMatchedPhotoIds` returns only the `match` photo.
3. Add a header comment documenting the Phase 4 contract surface this relies on.

**Expected output:** A single import path (`@/lib/gallery/matched-photos`) the rest of Phase 5 uses.

**Verification:** Unit test green; manual call against a seeded event returns expected IDs.

**Commit:** `feat(gallery): matched-photos helper reading user_event_matches from Phase 4`

---

### Task 3: Server query layer — Personal-mode tab queries

**Files:**
- Create: `lib/gallery/queries.ts`
- Create: `tests/gallery/queries.test.ts`

**Steps:**
1. Implement three exported functions, all taking `(userId, eventId, opts: { cursor?, limit? })` and returning `{ photos: Photo[], nextCursor: string | null, total: number }`:
   - `getYouTabPhotos` — for hosts: all photos in the event; for attendees: photos whose IDs are in `getMatchedPhotoIds(userId, eventId)`. Empty + `enrolled = false` → caller renders enrollment CTA.
   - `getByMeTabPhotos` — `WHERE photos.uploader_user_id = userId AND photos.event_id = eventId AND deleted_at IS NULL`. Always available regardless of enrollment.
   - `getOtherTabPhotos` — `WHERE photos.event_id = eventId AND has_detected_faces = false AND deleted_at IS NULL`. Same for host and attendee in Personal mode.
2. All three queries:
   - Order by `(uploaded_at DESC, photo.id DESC)`.
   - Honor `limit` (default 50).
   - Honor `cursor` of the form `${ts}_${id}` for stable keyset pagination.
   - Return `total` via a separate `COUNT(*)` query (acceptable at MVP scale; revisit if events exceed 5000 photos).
3. Add a `getEventTabsForRole` orchestrator that, given `(userId, eventId, role)`, returns the labels and counts for the tabs to render. Hosts always see all three. Attendees see all three but the You CTA changes if not enrolled.
4. Integration tests with seeded data covering the matrix in Exit Criterion 2.

**Expected output:** Pure functions, no auth checks (caller does auth). Stable contract for the API routes in Task 4.

**Verification:** Vitest integration suite. >90 % branch coverage on `queries.ts`.

**Commit:** `feat(gallery): personal-mode tab queries with cursor pagination`

---

### Task 4: API routes — gallery, view-tracking, photo-fetch authorization

**Files:**
- Create: `app/api/events/[id]/gallery/route.ts` (GET)
- Create: `app/api/photos/[id]/view/route.ts` (POST)
- Create: `app/api/photos/[id]/route.ts` (GET — returns presigned URL; **only if Phase 2 didn't ship one**)
- Create: `lib/gallery/auth.ts` exposing `canUserSeePhoto(userId, photoId): Promise<boolean>`
- Tests: `tests/api/gallery.test.ts`, `tests/api/photo-view.test.ts`, `tests/gallery/auth.test.ts`

**Steps:**
1. `GET /api/events/:id/gallery?tab=you|by_me|other&cursor=&limit=`:
   - Resolve current user; assert membership in event.
   - Read role from `event_members`.
   - Branch on tab → call corresponding `lib/gallery/queries` function.
   - Return `{ photos, nextCursor, total, tab, role, enrolled }`.
2. `POST /api/photos/:id/view`:
   - Resolve current user.
   - Call `canUserSeePhoto(userId, photoId)`; 403 if false.
   - Upsert into `photo_views`.
3. `canUserSeePhoto`: a photo is visible iff
   - the user uploaded it, **or**
   - the user is the host of its event, **or**
   - the user appears in it (`getMatchedPhotoIds` includes it), **or**
   - it has `has_detected_faces = false` and the user is a member of its event.
   Personal-mode-only. If `event.visibility_mode != 'personal'`, fall through to Personal logic and log a warning (we are explicitly not wiring the other modes).
4. Photo-fetch route returns a short-lived presigned R2 GET URL when authorized. **Skip if Phase 2 already exposes one**; in that case, retrofit `canUserSeePhoto` into the existing route and write a regression test.
5. Test: a user requesting a photo they're not in / didn't upload / isn't a no-people photo gets 403. Required for Exit Criterion 10.

**Expected output:** Three endpoints + one shared authorization helper.

**Verification:** Integration tests covering all four `canUserSeePhoto` branches plus the negative case.

**Commit:** `feat(gallery): gallery API and photo authorization`

---

### Task 5: Diff-download logic + bulk-save manifest

**Files:**
- Create: `lib/gallery/diff.ts`
- Create: `app/api/events/[id]/save-manifest/route.ts` (POST)
- Tests: `tests/gallery/diff.test.ts`, `tests/api/save-manifest.test.ts`

**Steps:**
1. `lib/gallery/diff.ts`:
   - `getUnsavedPhotoIds(userId, photoIds)` — returns subset where no `photo_saves` row exists for `(userId, photoId)`.
   - `getNewSinceLastSave(userId, eventId, tab)` — returns photos from the tab query whose `uploaded_at > MAX(saved_at) for (user, this event)`. If user has no saves yet, returns all.
   - `formatSinceLabel(savedAt)` — produces "since Tuesday" / "since 5h ago" / "since you last looked" with a documented locale strategy (English-only, `Intl.RelativeTimeFormat`).
2. `POST /api/events/:id/save-manifest`:
   - Body: `{ tab: 'you' | 'by_me' | 'other' | 'all_tabs', mode: 'new' | 'all', photoIds?: string[] }`.
   - Resolve user; assert membership.
   - Compute the set of photo IDs the client should save:
     - `'all'` → run the tab query (or union of all tabs if `'all_tabs'`) and return all visible IDs.
     - `'new'` → same, then filter through `getUnsavedPhotoIds`.
     - Explicit `photoIds` → validate each through `canUserSeePhoto` and return the surviving subset.
   - **Dedupe across tabs** — a photo I'm in AND uploaded shows once.
   - Return `{ photoIds: string[], totalBytes: number | null, recommendedMode: 'anchor' | 'zip' }` where `recommendedMode` is `'zip'` if `photoIds.length > BULK_SAVE_ZIP_THRESHOLD`, else `'anchor'`.
3. **Do not record `photo_saves` rows here.** The save itself is recorded in Task 6 once the client confirms the download initiated. This avoids inflating "saved" counts when the user cancels mid-flow.

**Expected output:** Pure logic in `diff.ts`; a single endpoint the client calls before any save action.

**Verification:** Unit + integration tests covering Exit Criterion 3.

**Commit:** `feat(gallery): diff-download manifest endpoint with dedupe`

---

### Task 6: Bulk save — anchor loop + ZIP fallback

**Files:**
- Create: `lib/gallery/bulk-save-client.ts` (browser-only utilities)
- Create: `app/api/events/[id]/zip/route.ts` (GET — streams ZIP)
- Create: `app/api/photos/saves/route.ts` (POST — record saves)
- Create: `components/BulkSaveButton.tsx`
- Tests: `tests/api/zip.test.ts`, manual device tests recorded into Section 4 of the protocol

**Steps:**
1. **Decide ZIP location.** Default: Next.js API route using `archiver` streaming Node response. Alternatives evaluated in Open Question 2. Record decision in `docs/plans/decisions.md` before coding.
2. Add dependency: `pnpm add archiver` (only if (a) chosen).
3. `lib/gallery/bulk-save-client.ts`:
   - `runAnchorLoop(photos: { id, presignedUrl, filename }[], onProgress, options: { delayMs: number })` — sequentially creates `<a download>` elements, clicks, removes. Default `delayMs = 75`. Catches and logs failures.
   - `runZipDownload(eventId, photoIds)` — sets `window.location = '/api/events/:id/zip?ids=...'` (or POST + presigned URL pattern depending on size).
   - `recordSaves(photoIds)` — `POST /api/photos/saves` with the IDs that the client believes initiated successfully.
4. `GET /api/events/:id/zip?ids=...`:
   - Auth: resolve user, validate every requested photo through `canUserSeePhoto`.
   - 403 if any fail (don't silently filter — surfaces tampering).
   - Stream a ZIP using `archiver`, fetching each R2 object via presigned URL and piping into the archive. Set `Content-Disposition: attachment; filename="event-${name}-photos.zip"`.
   - **Watch for Vercel's response timeout**: if the runtime is `nodejs` (default), 5-minute Pro tier limit applies; document this and cap ZIP at e.g. 500 photos, returning 413 above that with a "split into batches" hint in the response.
5. `POST /api/photos/saves`: body `{ photoIds: string[] }`. For each, validate via `canUserSeePhoto`, then upsert `photo_saves` with `savedAt = now()`.
6. `components/BulkSaveButton.tsx`:
   - Default label: "Save N new" computed from `save-manifest` preview call.
   - Toggle: "Save all M".
   - On click: fetch manifest → if `recommendedMode === 'anchor'`, run anchor loop and call `recordSaves`; else trigger ZIP download (record saves on the redirect's response or on a `beforeunload`/`success` callback).
   - Show progress (X of Y).
   - Read `BULK_SAVE_ZIP_THRESHOLD` from a server-injected config object — **never** hard-code in the client bundle; threshold can be tuned without redeploy if read at request time.
7. **Run the device tests** from protocol Section 4 against this implementation. Fill in the tables. If the practical iOS limit differs from `N_seed`, update `BULK_SAVE_ZIP_THRESHOLD` and re-run a smoke check.
8. **Lock the threshold.** Append to `docs/milestone-0-device-test-protocol.md` Section 5 with date, tester, and chosen value. Update `.env.example`.

**Expected output:** Working bulk save with both code paths and a documented threshold.

**Verification:** Manual device runs (recorded in protocol); integration test for ZIP route auth and 413 cap; unit test for the threshold-branch logic in `BulkSaveButton`.

**Commit:** `feat(gallery): bulk save with anchor loop and ZIP fallback`

---

### Task 7: Pagination + virtualization for >200 photos

**Files:**
- Modify: `components/Gallery.tsx` (created in Task 8 if not yet — sequence Task 8 before this if needed)
- Create: `lib/gallery/cursor.ts`
- Tests: `tests/gallery/cursor.test.ts`, `e2e/gallery-pagination.spec.ts`

**Steps:**
1. `lib/gallery/cursor.ts` — encode/decode `(uploaded_at, id)` cursors (base64 JSON). Validate inputs.
2. Update `lib/gallery/queries.ts` (Task 3 placeholder) to use the cursor module.
3. In the gallery component, use `IntersectionObserver` on a sentinel below the last row. When it intersects, fetch next page using `nextCursor`.
4. Hold a max of `~600` photo DOM nodes in memory; if user scrolls past, drop earlier batches (or accept the memory cost — measure at 600 photos with Chrome DevTools, document trade-off). **Decision rule**: ship with simple infinite scroll; switch to `react-virtuoso` if the 600-photo memory test shows >150 MB JS heap.
5. Playwright fixture: seed 250 photos, load gallery, assert first response under 300 ms server time and that scrolling triggers a second `/gallery` request.

**Expected output:** Performant rendering up to a few thousand photos in an event.

**Verification:** Playwright e2e green; manual smoke at 250 photos on a mid-tier Android.

**Commit:** `perf(gallery): cursor pagination and infinite scroll`

---

### Task 8: Gallery UI — three tabs, header, empty states, saved indicator

**Files:**
- Create: `app/(app)/events/[id]/gallery/page.tsx` (server component)
- Create: `components/Gallery.tsx`
- Create: `components/GalleryTabs.tsx`
- Create: `components/PhotoTile.tsx` (with saved-checkmark)
- Create: `components/EnrollmentCTA.tsx`
- Create: `components/ExpiryBannerSlot.tsx` (empty placeholder for Phase 6)

**Steps:**
1. Server-render the gallery page: load user, event, role, initial tab data, initial enrollment status. Pass to `<Gallery />`.
2. `<GalleryTabs />` renders the three tabs with counts (You: 23, By Me: 4, Other: 11). Selected tab in URL (`?tab=you` default) for shareability.
3. `<Gallery />` shows:
   - Tab header: "23 photos of you · 5 new since Tuesday" or analogous for By Me / Other.
   - `<BulkSaveButton />` (Task 6).
   - Photo grid of `<PhotoTile />` with saved-state checkmark when `photo_saves` row exists for the current user.
   - Sentinel for infinite scroll.
4. **Empty states** per tab:
   - You + not enrolled: "Enroll your face to see photos of you" → `<EnrollmentCTA />` deep-links into Phase 4 enrollment flow.
   - You + enrolled + zero matches: "We haven't found photos of you yet — check back as more get uploaded."
   - By Me + zero: "You haven't uploaded any photos here yet."
   - Other + zero: "No people-free photos in this event yet."
5. After every successful bulk save, optimistically toggle the saved checkmark on tiles in `photoIds`; reconcile with server response.
6. Mount `<ExpiryBannerSlot />` above the tabs as a no-op div with `data-slot="expiry-banner"` so Phase 6 has a stable mount point.

**Expected output:** A working gallery the rest of the team can demo end-to-end against a seeded event.

**Verification:**
- Playwright e2e: enrolled user with 3 face matches and 1 upload sees correct counts and tabs.
- Manual smoke on iOS Safari + Android Chrome.
- Visual check at 0, 1, 50, 250 photos per tab.

**Commit:** `feat(gallery): three-tab UI with diff-download header and saved indicator`

---

### Task 9: Authorization hardening + visibility-mode guard

**Files:**
- Modify: `lib/gallery/auth.ts`, `lib/gallery/queries.ts`
- Create: `tests/gallery/visibility-mode-guard.test.ts`

**Steps:**
1. Wrap every gallery query and the `canUserSeePhoto` helper in a check: if `event.visibility_mode !== 'personal'`, log structured warning (`tag: 'visibility-mode-not-wired'`) and proceed with Personal-mode logic. **Do not 500.**
2. Add a unit test that:
   - Hand-edits an event row to `visibility_mode = 'open_pool'`.
   - Asserts the gallery still returns Personal-mode results (no "All" tab, no leaks).
   - Asserts the warning fires.
3. Add a top-of-file comment in `auth.ts` calling out: "Phase 5 only wires Personal mode. Adding `open_pool` / `host_only` requires changes to `canUserSeePhoto` AND `getYouTabPhotos` AND tab labels."

**Expected output:** Defense-in-depth so a misconfigured event row cannot accidentally leak photos under non-Personal modes.

**Verification:** Unit test green. Code review confirms no UI surface lights up for non-Personal modes.

**Commit:** `feat(gallery): defensive visibility-mode guard for non-personal modes`

---

### Task 10: E2E and load smoke

**Files:**
- Create: `e2e/gallery-personal-mode.spec.ts`
- Create: `e2e/gallery-by-me.spec.ts`
- Create: `e2e/gallery-bulk-save-anchor.spec.ts`
- Create: `e2e/gallery-bulk-save-zip.spec.ts`
- Create: `scripts/seed-gallery-fixtures.ts` (read-only seeding helper)

**Steps:**
1. Seed an event with 250 photos: 30 face-matched to user A, 50 uploaded by user A, 80 with no faces, the rest matched to other users.
2. E2E covering Exit Criteria 2, 3, 7, 8, 11.
3. For ZIP test: hit the route headlessly, confirm response is `application/zip` with a non-trivial size and the right filename.
4. For anchor-loop test: stub `window.HTMLAnchorElement.prototype.click` and assert N calls.

**Expected output:** A green CI run with all gallery e2es.

**Verification:** All exit-criteria tests pass in GitHub Actions.

**Commit:** `test(gallery): e2e suite for Phase 5`

---

## Phase 5 review checkpoint

Before declaring Phase 5 complete and moving to Phase 6:

1. **Self-review.** Walk through Exit Criteria 1-12 and tick off each with the test or commit reference that proves it.
2. **Run `superpowers:requesting-code-review`** on the diff. Address Critical and Important findings. File Suggestion-class items as Phase 6 tickets.
3. **Verify the device-test threshold lock-in.** Open `docs/milestone-0-device-test-protocol.md` Section 5 and confirm the bulk-save threshold row is filled with date, tester, value. Open `docs/plans/decisions.md` and confirm the same value is recorded.
4. **Cross-phase contract walk.**
   - Re-read "Cross-phase contracts assumed" above. Did Phase 4 actually ship `getMatchedPhotoIds`? If we built our own path in Task 2, file a Phase-6 cleanup ticket to consolidate.
   - Confirm `<ExpiryBannerSlot />` has stable selectors documented in `components/ExpiryBannerSlot.tsx` for Phase 6.
   - Confirm `lib/gallery/diff.ts` exports are stable; flag any planned breaking changes for Phase 6 reviewer.
5. **Performance smoke.** Load the 250-photo seeded event on a real Android device. Time-to-first-tile under 1 s on 4G. Memory under 200 MB after scrolling to bottom.
6. **Privacy walk-through.** Manually attempt to fetch a photo not visible to the current user; confirm 403. Manually browse with `?tab=you` while logged in as an unenrolled user; confirm enrollment CTA, zero photo content, no API leaks in the network tab.
7. **Sign off.** Append a one-line note to this file: "Phase 5 sign-off: <name> <date>, BULK_SAVE_ZIP_THRESHOLD=<N>, matched-photos source=<phase-4-helper|inline-join>." Then begin writing Phase 6.

If any review item fails, do not proceed to Phase 6. Fix in Phase 5 and re-run the checkpoint.

---

## Salvageable for Pocket v1

If Pocket v0 self-use succeeds and v1 begins, these pieces of Phase 5 may be worth lifting (scoped per-pocket, not three-tab):

- **Bulk save flow** (anchor-loop with iOS PWA dialog-fatigue threshold, ZIP fallback above N photos). Directly applicable to "save all my matches from this pocket" UX.
- **Diff-download tracking** (`photo_saves` table or simpler per-user/per-photo flag) so re-opening a pocket only offers new photos for save.
- **Pagination/virtualization** at >200 photos — Pocket scale could hit this with active group chats.
- **Authorization helper hardening** (`canUserSeePhoto`) — Pocket v0 currently leans on share-link tokens; v1 should harden the owner-side fetch path.

The three-tab gallery (You / By Me / Other), `photo_views`, and Phase 4 matching contract are NOT salvageable — Pocket has anonymous contributors and a single owner-facing feed.

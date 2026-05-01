# Photo Courier — Phase 4: Enrollment + Matching

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Source:** Expands the Phase 4 outline in `2026-04-27-photo-courier-implementation.md` to the same fidelity as Phase 1, informed by the Codex roadmap (`2026-04-27-photo-courier-implementation-codex.md` — Milestone 4) and the device caveats in `milestone-0-device-test-protocol.md`.

**Phase goal:** A user can give explicit consent, capture 5-7 face frames on iOS Safari / iOS PWA / Android Chrome, have those frames embedded by the Phase 3 worker, store a centroid `face_embedding`, and immediately see a banded `match` / `maybe you` / `no match` retrieval against pre-existing `face_clusters` in the current event — Personal mode only.

---

## End state of Phase 4

- A logged-in event member can launch a multi-angle capture flow that works on iOS Safari, iOS-installed PWA, and Android Chrome with a documented canvas fallback for browsers without `ImageCapture`.
- An explicit consent modal (Legal-approved copy) blocks the camera stream until accepted; declining returns the user to the event landing page with no embedding side effects.
- The capture flow records 5-7 angle-prompted frames, validates orientation/EXIF before upload, posts them to an ephemeral R2 prefix, and calls a worker `POST /enroll` endpoint that returns `{ centroid: float[128], variance: number, quality_score: number, accepted: bool }`.
- On `accepted: true`, the centroid is persisted to `users.face_embedding`; on rejection the user gets a "let's try that again" retry path.
- Per-angle embeddings are persisted to a new `face_enrollment_frames` table for diagnostics and re-centroid recompute. Raw frames are deleted from R2 immediately after the worker returns.
- A pgvector cosine-similarity query against `face_clusters` (event-scoped) returns banded results: `match` (cosine ≥ T_match), `maybe_you` (T_maybe ≤ cosine < T_match), and below `T_maybe` is dropped.
- A new `user_event_matches` table stores `(user_id, event_id, cluster_id, score, band)` so the gallery (Phase 5) can read matches without recomputing.
- A profile deletion endpoint immediately purges `users.face_embedding`, `face_enrollment_frames`, and `user_event_matches`.
- Personal-mode UI only. `open_pool` and `host_only` UI surfaces remain deferred.

---

## Exit criteria

Phase 4 is done when all of the following hold:

1. **Consent before camera** — Camera stream cannot start until the consent modal is accepted; accepting inserts a `consent_acceptances` row, declining logs an `audit_events` entry. User is redirected on decline. Verified by Vitest API test + Playwright UI test.
2. **Multi-angle capture works on tier-1 devices** — A test user successfully completes enrollment end-to-end on at least one device per tier from `milestone-0-device-test-protocol.md`: iOS Safari (latest), iOS PWA (latest, installed), Android Chrome (latest). Captured manually, recorded in a results table.
3. **Canvas fallback verified** — On iOS Safari (which lacks `ImageCapture`), the capture path uses `<video>` + `canvas.drawImage` + `canvas.toBlob`. A unit test stubs `window.ImageCapture` undefined and asserts the canvas path runs.
4. **Worker contract honored** — `POST /enroll` is called with the documented request shape and the returned centroid is what gets stored. Contract test in `worker/tests/test_enroll.py` and a Vitest mock-based contract test on the Next.js side both pass.
5. **Frames are ephemeral** — A scheduled-on-success deletion (sync, before responding 200) removes all raw enrollment frames from R2. Verified by an integration test that asserts the R2 keys are gone after the API returns.
6. **Banded matching returns at least three states** — For a synthetic test case with three known clusters at distances above/inside/below the threshold band, the matching API returns one `match`, one `maybe_you`, and excludes the third. Vitest test using a fixture pgvector dataset.
7. **Matches persist** — `user_event_matches` rows are written and re-readable; gallery queries in Phase 5 can join against this table without recomputing similarity.
8. **Profile deletion is destructive and audited** — `DELETE /api/me/face-profile` clears centroid, frame rows, match rows, and writes an `audit_events` row. Vitest test confirms all four side effects.
9. **CI green** — Lint, unit, integration, and worker pytest all pass on GitHub Actions.

---

## Explicitly deferred

Do not build any of these in Phase 4:

- `open_pool` or `host_only` visibility UI (schema only; gallery filters live in Phase 5)
- Liveness check beyond "you must move your head between prompts" (no MediaPipe blink/depth, no anti-spoof)
- Background re-matching when new clusters are formed (gallery fetch in Phase 5 will recompute on read)
- Per-device performance optimization beyond "works on tier-1 devices in under ~30s"
- "Invite this person from an unrecognized face" viral loop
- Cross-event identity reuse UI (the embedding *does* persist account-wide per design doc, but no UI yet exposes "I already enrolled — apply to this new event")
- Push or in-app notifications for new matches (Phase 6)
- Cleanup of expired event match rows (Phase 6 cleanup cron)
- Bulk re-enrollment / "redo my face profile" beyond delete + start over

---

## Open questions

These should be answered during Phase 4 but do not block kickoff:

1. **Per-angle embedding retention period.** Default: keep `face_enrollment_frames` rows alongside the centroid until the user deletes their profile. Alternative: drop them after 30 days. Decide once we have an ML signal on whether re-centroid recompute is ever useful.
2. **Reject-and-retry budget.** How many consecutive failed enrollments before we lock the user out for 24h to prevent stress-testing? Default: 5 attempts/hour, soft-rate-limited by IP + user id.
3. **`maybe_you` UX surface in gallery.** Phase 5 owns the actual rendering, but Phase 4 must decide whether to *return* `maybe_you` rows from the matching API. Default: yes, return them with a `band` field.
4. **Threshold tuning loop.** If Milestone 0 benchmarks deliver thresholds but beta data shifts them, how do we ship a threshold change? Default: thresholds in env vars `MATCH_THRESHOLD` and `MAYBE_THRESHOLD`, no migrations needed.
5. **Quality score storage.** `users.face_quality_score` exists from Phase 1 schema. Do we use it to gate retries (re-prompt if score < N)? Default: yes, threshold in env var; reject and retry if quality < `MIN_ENROLL_QUALITY`.

---

## Prerequisites — gated decisions that block Phase 4 coding

Phase 4 cannot start UI/API work until both of these are signed off and recorded in this plan:

| Decision | Owner | Unblocks | Default if unanswered when work starts |
|---|---|---|---|
| Matching threshold values: `MATCH_THRESHOLD` (cosine ≥ X → "match"), `MAYBE_THRESHOLD` (Y ≤ cosine < X → "maybe you"), discard below `MAYBE_THRESHOLD` | Product + ML | Tasks 9, 10, 11 (matching API, banding, gallery API) | **Stub values 0.55 / 0.42** behind env vars; ship a `# THRESHOLDS_PROVISIONAL` flag in code review and refuse beta launch until replaced |
| Consent wording for: face enrollment modal, profile deletion modal, privacy policy paragraph on biometric data | Legal + Product | Tasks 2, 3, 13 (consent modal, frames upload UX, deletion endpoint) | **Placeholder copy with `LEGAL_REVIEW_REQUIRED` banner** visible in dev/staging; deployment to prod blocked by a pre-deploy check that fails if the banner is still present |

These are surfaced from the Phase 1 "Approval checkpoints" table. If either is unresolved when Phase 4 starts, log it in the kickoff note and proceed with the defaults; do *not* wire either to a beta-eligible build.

---

## Cross-phase contracts assumed

**Inputs from Phase 3 (recognition worker):** Phase 4 depends on the worker exposing:
- `POST /enroll` — body: `{ frame_keys: string[] }` (R2 keys for ephemeral upload prefix); response: `{ accepted: bool, centroid: number[128] | null, per_frame_embeddings: number[128][], variance: number, quality_score: number, reject_reason?: string }`. The worker pulls each frame from R2, runs RetinaFace + SFace, computes per-frame embeddings, then centroid + variance.
- `face_clusters` table populated incrementally by the worker, with `representative_embedding vector(128)` and `event_id` columns.
- HMAC-signed internal auth header (`X-Worker-Signature`) shared with `WORKER_SECRET`.
- Health endpoint `GET /health` (already stubbed in Phase 1).

If Phase 3's worker contract differs, Task 9 (worker call wrapper) is the integration seam; only that file changes.

**Outputs to Phase 5 (gallery):** Phase 4 produces:
- `users.face_embedding` populated for enrolled users.
- `user_event_matches` table with `(user_id, event_id, cluster_id, score, band)` — Phase 5's "You" tab reads this directly.
- `GET /api/events/:id/my-matches` endpoint that returns banded matches; Phase 5 wraps this for the gallery rendering.
- `consent_acceptances` rows that Phase 6 will reference for compliance reporting (table created here; Phase 6 Task 7 only adds the `privacy_policy` and `terms_of_service` document types).

---

## Tasks

### Task 1: Schema — `face_enrollment_frames`, `user_event_matches`, `consent_acceptances`

**Files:**
- Modify: `db/schema.ts`
- Create: `db/migrations/000X_phase4_enrollment.sql` (auto-generated)

**Step 1: Add `face_enrollment_frames` schema**

Append to `db/schema.ts`:
```ts
export const faceEnrollmentFrames = pgTable('face_enrollment_frames', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  frameIndex: integer('frame_index').notNull(),         // 0..N-1
  anglePrompt: text('angle_prompt').notNull(),          // 'front' | 'left' | 'right' | 'up' | 'down' | 'mid_left' | 'mid_right'
  embedding: vector('embedding', 128).notNull(),
  qualityScore: integer('quality_score'),
  capturedAt: timestamp('captured_at').notNull().defaultNow(),
})
```

**Step 2: Add `user_event_matches` schema**

```ts
export const userEventMatches = pgTable('user_event_matches', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  clusterId: uuid('cluster_id').notNull(),              // FK added in Phase 3 face_clusters; soft FK here
  score: real('score').notNull(),                       // cosine similarity at compute time
  band: text('band', { enum: ['match', 'maybe_you'] }).notNull(),
  computedAt: timestamp('computed_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.eventId, t.clusterId] }) }))
```

**Step 3: Add `consent_acceptances` schema**

This table uses the broader shape from Phase 6 Task 7 so it generalises to ToS and privacy policy without a migration later. Declines are not recorded as rows; instead, a declined consent is logged as an `audit_events` entry.

```ts
export const consentAcceptances = pgTable('consent_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  document: text('document', { enum: ['privacy_policy', 'terms_of_service', 'enrollment_biometric'] }).notNull(),
  version: text('version').notNull(),    // e.g. '2026-04-27-DRAFT'
  acceptedAt: timestamp('accepted_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
}, (t) => ({
  uniqAcceptance: uniqueIndex('consent_acceptances_user_doc_version_uniq').on(t.userId, t.document, t.version),
}))
```

**Step 4: Add `audit_events` schema**

Phase 1 does not define this table; Phase 4 owns it because Phase 4 is the first phase that needs an immutable audit trail (consent declines, profile deletion). Phase 6 inserts into it for compliance events too — same shape, no migration needed there.

```ts
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }), // nullable; system-generated events have no user
  kind: text('kind').notNull(),          // free-form string; e.g. 'consent_declined', 'face_profile_deleted', 'enrollment_rejected'
  payload: jsonb('payload'),             // event-specific structured data
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  byUser: index('audit_events_user_idx').on(t.userId),
  byKind: index('audit_events_kind_idx').on(t.kind, t.createdAt),
}))
```

**Step 5: Generate + apply migration**

```bash
pnpm db:generate && pnpm db:migrate
```

**Expected output:** Four new tables visible in `pnpm db:studio`. `users.face_embedding` and `users.face_quality_score` columns from Phase 1 are reused, not duplicated.

**Verification:**
- `pnpm db:studio` shows all three tables with expected columns.
- `\d consent_acceptances` shows `document` and `version` columns and the unique index on `(user_id, document, version)`.
- A throwaway insert/select against each table succeeds.

---

### Task 2: Consent modal component (placeholder copy with legal-review banner)

**Files:**
- Create: `components/enroll/ConsentModal.tsx`
- Create: `lib/consent/copy.ts` (single source of truth for consent strings)
- Create: `tests/components/consent-modal.test.tsx`

**Step 1: Capture wording placeholder** at `lib/consent/copy.ts`

```ts
// LEGAL_REVIEW_REQUIRED — replace before any prod build
export const FACE_ENROLL_CONSENT = {
  document: 'enrollment_biometric' as const,
  version: '2026-04-27-DRAFT',
  title: 'Enrolling your face',
  body: [
    '[PLACEHOLDER — Legal/Product to finalize.]',
    'We will capture 5-7 photos of your face from different angles.',
    'We compute a numeric face signature and delete the raw photos within seconds.',
    'The signature is used only to find photos of you within events you join.',
    'You can delete your face profile any time from your profile page.',
  ].join(' '),
  acceptLabel: 'I consent — start camera',
  declineLabel: 'Not now',
} as const

export const FACE_DELETE_CONSENT = {
  document: 'enrollment_biometric' as const,
  version: '2026-04-27-DRAFT',
  title: 'Delete your face profile',
  body: '[PLACEHOLDER — Legal/Product to finalize.] This permanently removes your face signature and any matched photo associations. This cannot be undone.',
  confirmLabel: 'Delete my face profile',
  cancelLabel: 'Keep it',
} as const
```

**Step 2: Build the modal** at `components/enroll/ConsentModal.tsx`

Render a `Dialog` (shadcn) that:
- Shows title + body
- Has Accept and Decline buttons
- On Accept: POSTs to `/api/me/consent` with `{ document, version }` (from the consent object), then calls `onAccept()`
- On Decline: logs an `audit_events` entry client-side (no POST to `/api/me/consent` — declines are not recorded as acceptance rows), then calls `onDecline()`
- Renders a `LEGAL_REVIEW_REQUIRED` banner if `process.env.NEXT_PUBLIC_LEGAL_APPROVED !== '1'`

**Step 3: Test** — render the modal, click Accept, assert the fetch was called with the right body; click Decline, assert the same. Assert the banner is visible when env flag is unset.

**Step 4: Commit**
```bash
git add components/enroll/ConsentModal.tsx lib/consent/copy.ts tests/components/consent-modal.test.tsx
git commit -m "feat(phase4): consent modal with placeholder copy and legal-review banner"
```

**Expected output:** Modal renders, fetch mock receives both decisions, banner visible in dev.

**Verification:** `pnpm test tests/components/consent-modal.test.tsx` passes; visual smoke at `/enroll` shows the modal first.

---

### Task 3: API route — record consent decision

**Files:**
- Create: `app/api/me/consent/route.ts`
- Create: `tests/api/consent.test.ts`

**Step 1: Write integration test** — POST `{ document, version }` while authenticated; assert one row inserted into `consent_acceptances` with `userId`, `ipAddress`, `userAgent`, `document`, and `version` populated; assert 401 when unauthenticated. Declines are not posted to this endpoint — a declined consent should instead fire an `audit_events` insert on the client side.

**Step 2: Implement** — auth via `getCurrentUser`, parse body, insert into `consent_acceptances` using `ON CONFLICT (user_id, document, version) DO NOTHING` (re-accepting the same version is idempotent), return `{ ok: true }`.

**Step 3: Test passes.**

**Step 4: Commit.**

**Expected output:** Row written; idempotent re-acceptance allowed (we keep history, not single state).

**Verification:** Vitest passes; manual `curl` against dev shows row in DB.

---

### Task 4: Capture-page scaffold + camera-stream hook with iOS Safari fallback

**Files:**
- Create: `app/(app)/events/[id]/enroll/page.tsx`
- Create: `components/enroll/CaptureSession.tsx`
- Create: `lib/camera/useCameraStream.ts`
- Create: `lib/camera/captureFrame.ts`
- Create: `tests/lib/captureFrame.test.ts`

**Step 1: `useCameraStream` hook** at `lib/camera/useCameraStream.ts`

- Calls `navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'user' } }, audio: false })`.
- Handles permission-denied, no-front-camera, and stream-suspended (visibility change) cases per the device protocol.
- Cleans up on unmount.

**Step 2: `captureFrame` utility** at `lib/camera/captureFrame.ts`

```ts
export async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  // Always use canvas path — iOS Safari does not support ImageCapture.
  // (See milestone-0-device-test-protocol.md §1 "Known limitations".)
  // ImageCapture would be faster on Android; not worth a branch given the
  // iOS-required canvas path already works on all tier-1 devices.
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, 0, 0)
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.9)
  })
}
```

EXIF/orientation: because we draw the live `<video>` to a canvas at the moment of capture, the resulting JPEG has no rotated EXIF metadata and pixels are already in the orientation the user is seeing. This sidesteps the orientation/EXIF gotcha called out in the device protocol §1. Document this in a code comment.

**Step 3: Unit test** — set `window.ImageCapture = undefined`, mock a `<video>` with `videoWidth`/`videoHeight` and a fake `drawImage`-capable canvas (jsdom has limited canvas; use `vitest-canvas-mock`). Assert `captureFrame` returns a Blob.

**Step 4: Capture page scaffold** — gates the `<video>` element behind the consent modal from Task 2. Renders the `CaptureSession` only after consent is recorded.

**Step 5: Commit.**

**Expected output:** `/events/:id/enroll` shows the consent modal; on accept, the camera preview activates.

**Verification:**
- Unit test passes.
- Manual: `pnpm dev`, open in iOS Simulator Safari → consent → camera preview appears → tap a "Capture" button → JPEG Blob produced.

---

### Task 5: Multi-angle capture sequence UI

**Files:**
- Modify: `components/enroll/CaptureSession.tsx`
- Create: `lib/enroll/anglePrompts.ts`

**Step 1: Define the angle sequence** at `lib/enroll/anglePrompts.ts`:

```ts
export const ANGLE_PROMPTS = [
  { key: 'front',     label: 'Look straight at the camera' },
  { key: 'left',      label: 'Turn your head slowly to the left' },
  { key: 'right',     label: 'Turn your head slowly to the right' },
  { key: 'up',        label: 'Tilt your head up' },
  { key: 'down',      label: 'Tilt your head down' },
  { key: 'mid_left',  label: 'Halfway between front and left' },
  { key: 'mid_right', label: 'Halfway between front and right' },
] as const
```

**Step 2: UI** — for each prompt: show label, show a 3-second countdown with the live preview, capture a frame via `captureFrame`, append to local state. Show a progress bar (`3/7`). After the last prompt, show a "Submit" button.

**Step 3: Orientation handling** — listen for `orientationchange`; if the user rotates mid-sequence, pause prompts and ask them to hold still until the stream stabilizes (per device protocol §1, mid-session rotation can break the stream on iOS).

**Step 4: Manual smoke test** — complete the sequence in dev, verify 7 Blobs are in state.

**Step 5: Commit.**

**Expected output:** A guided 7-prompt sequence that yields 7 in-memory JPEG Blobs.

**Verification:** Manual run on a desktop browser; tier-1 device runs deferred to Task 14.

---

### Task 6: API route — issue ephemeral R2 upload URLs for enrollment frames

**Files:**
- Create: `app/api/me/enroll/upload-urls/route.ts`
- Create: `tests/api/enroll-upload-urls.test.ts`
- Modify: `lib/r2.ts` (Phase 2 helper) to expose a `presignEnrollmentPut(userId, frameIndex)` helper that uses the prefix `enrollments/{userId}/{nonce}/{frameIndex}.jpg`.

**Step 1: Implement** — POST returns `{ nonce, urls: [{ key, putUrl }] * N }`. Each URL is short-lived (60s).

**Step 2: Integration test** — assert N URLs returned, assert keys all start with `enrollments/{userId}/{nonce}/`.

**Step 3: Commit.**

**Expected output:** Client can PUT each frame Blob to its presigned URL.

**Verification:** Vitest passes; manual integration deferred to Task 9.

---

### Task 7: Client uploads frames to R2

**Files:**
- Modify: `components/enroll/CaptureSession.tsx`
- Create: `lib/enroll/uploadFrames.ts`
- Create: `tests/lib/uploadFrames.test.ts`

**Step 1: `uploadFrames(blobs)`** — fetches `/api/me/enroll/upload-urls`, then `PUT`s each Blob to its URL with `Content-Type: image/jpeg`. Returns `{ nonce, frameKeys }`.

**Step 2: Wire to CaptureSession** — after the user clicks "Submit," call `uploadFrames`, show progress.

**Step 3: Unit test** — mock fetch, assert each PUT happens with the right Content-Type.

**Step 4: Commit.**

**Expected output:** Frames land in R2 under `enrollments/{userId}/{nonce}/`.

**Verification:** Use `aws s3 ls` against R2 in dev to confirm objects exist (will be deleted in Task 9 immediately after embedding).

---

### Task 8: Worker contract — `POST /enroll` (Phase 3 deliverable; here we add a contract test)

**Files:**
- Create: `worker/tests/test_enroll_contract.py`
- Create: `tests/contracts/worker-enroll.test.ts`

**Step 1: Python contract test** — given the `frame_keys` request shape, assert the response JSON matches `{ accepted, centroid, per_frame_embeddings, variance, quality_score, reject_reason? }`. Use a fixture image set checked into `worker/tests/fixtures/enroll/`.

**Step 2: Next.js contract test** — mock `fetch` to return a known response, assert our wrapper (built next task) parses it correctly.

**Step 3: If Phase 3 worker has not yet exposed `/enroll`, file a blocker and pause Phase 4 until the worker contract test runs green.** Do not invent a different contract.

**Step 4: Commit.**

**Expected output:** Both contract tests pass against the Phase 3 worker stub or the deployed worker.

**Verification:** `pnpm test tests/contracts/` and `pytest worker/tests/test_enroll_contract.py` both pass.

---

### Task 9: API route — `POST /api/me/enroll` (orchestrates worker + persistence + cleanup)

**Files:**
- Create: `app/api/me/enroll/route.ts`
- Create: `lib/worker/client.ts` (HMAC-signed worker call wrapper)
- Create: `tests/api/enroll.test.ts`

**Step 1: Worker client wrapper** — `enrollFrames(frameKeys: string[]) → Promise<EnrollResponse>` posts to `${WORKER_URL}/enroll` with `X-Worker-Signature` HMAC.

**Step 2: Implement enrollment route**

Pseudocode (no actual code committed by this plan):
1. `getCurrentUser`; require auth.
2. Confirm a `consent_acceptances` row exists for `(user_id, document='enrollment_biometric', version=current_version)` where `current_version` is the value exported from `lib/consent/copy.ts`; reject with 412 if not.
3. Validate `{ nonce, frameKeys }` from body; assert keys are under `enrollments/{userId}/{nonce}/`.
4. Call `enrollFrames(frameKeys)` (Phase 3 worker).
5. **Best-effort delete** all R2 keys under that nonce *before* returning, even on rejection (privacy promise from design doc line 257). Use a `try/finally` so deletion still happens if worker call throws.
6. If `accepted: false`, return `{ accepted: false, rejectReason }` to client; do NOT touch DB.
7. If `accepted: true`:
   - Update `users.face_embedding`, `users.face_quality_score`, `users.face_enrolled_at`.
   - Insert per-frame rows into `face_enrollment_frames`.
   - Insert audit row into `audit_events` (created in Task 1) with `kind='enrollment_accepted'`.
8. Return `{ accepted: true, qualityScore }`.

**Step 3: Integration test** — mock worker client to return a known accepted response, assert all four side effects happened, AND assert R2 deletion was called regardless of outcome.

**Step 4: Failure-path test** — worker returns `{accepted:false, rejectReason:'high_variance'}`; assert no DB writes, R2 still cleaned up, response is 200 with `{accepted:false}`.

**Step 5: Commit.**

**Expected output:** Centroid lives in `users.face_embedding`; per-frame embeddings live in `face_enrollment_frames`; raw frames are gone from R2.

**Verification:** Vitest tests pass; manual test in dev environment confirms R2 prefix is empty 1s after the API returns.

---

### Task 10: API route — banded matching `GET /api/events/:id/my-matches`

**Files:**
- Create: `app/api/events/[id]/my-matches/route.ts`
- Create: `tests/api/my-matches.test.ts`
- Modify: `lib/env.ts` to surface `MATCH_THRESHOLD` and `MAYBE_THRESHOLD` env vars with safe defaults (`0.55` and `0.42` — flagged as `THRESHOLDS_PROVISIONAL`).

**Step 1: Implement**

1. Auth + event-membership check (re-use Phase 1 pattern from `/api/events/[id]`).
2. Load `users.face_embedding` for current user; if null → return `{ enrolled: false, matches: [] }`.
3. Run pgvector query (cite design doc lines 126-132):
   ```sql
   SELECT id AS cluster_id, 1 - (representative_embedding <=> $userVec::vector) AS score
   FROM face_clusters
   WHERE event_id = $eventId
   ORDER BY representative_embedding <=> $userVec::vector
   LIMIT 25;
   ```
4. Band each row:
   - score ≥ `MATCH_THRESHOLD` → `match`
   - `MAYBE_THRESHOLD` ≤ score < `MATCH_THRESHOLD` → `maybe_you`
   - else → drop
5. **Upsert** banded rows into `user_event_matches` (`ON CONFLICT (user_id, event_id, cluster_id) DO UPDATE SET score, band, computedAt`).
6. Return `{ enrolled: true, matches: [{ clusterId, score, band }] }`.

**Step 2: Test with fixture clusters**

- Seed three `face_clusters` rows with embeddings at known cosine distances (≥ T_match, in band, below T_maybe).
- Call the route, assert response has exactly 2 entries (1 match, 1 maybe_you) and `user_event_matches` has 2 rows.

**Step 3: Test "not enrolled"** — user with null embedding returns `{ enrolled: false }`.

**Step 4: Commit.**

**Expected output:** Banded matches returned and persisted; threshold env vars used.

**Verification:** Vitest passes; manual run after Task 9 enrollment shows real clusters from the event.

---

### Task 11: Trigger initial match computation immediately after enrollment

**Files:**
- Modify: `app/api/me/enroll/route.ts`
- Create: `lib/match/computeForEvent.ts`

**Step 1: Extract the matching SQL + banding from Task 10's route into a reusable `computeMatchesForUserEvent(userId, eventId)`**.

**Step 2: In `/api/me/enroll`,** after persisting the centroid (Task 9 step 7), call `computeMatchesForUserEvent(userId, currentEventId)` for the event the user is enrolling from. Return matches in the response so the client can navigate to the gallery with results already populated.

This honors the cross-phase contract: matching is **synchronous** at enrollment (no worker round-trip; pgvector query against existing clusters from Phase 3) and **on-read** in Phase 5's gallery (recompute via the same helper).

**Step 3: Test** — end-to-end: seed clusters, mock worker enroll, hit enroll endpoint, assert response includes matches and `user_event_matches` rows exist.

**Step 4: Commit.**

**Expected output:** Successful enrollment immediately yields banded matches without a second client request.

**Verification:** Vitest integration test passes.

---

### Task 12: Enrollment results UI

**Files:**
- Create: `components/enroll/EnrollmentResult.tsx`
- Modify: `app/(app)/events/[id]/enroll/page.tsx`

**Step 1: Render** — three states:
- **Accepted with matches:** "We found N photos that look like you, plus M more we're not sure about." CTAs: "See my photos" → routes to `/events/:id` gallery (Phase 5).
- **Accepted, zero matches yet:** "Enrollment saved. We'll let you know when photos of you appear." CTA: "Back to event."
- **Rejected:** "We couldn't get a clear read. Let's try once more." CTA: "Retry" → resets the capture session. Track retry count for Open Question 2.

**Step 2: Manual smoke test.**

**Step 3: Commit.**

**Expected output:** A friendly result screen.

**Verification:** Manual; full device-tier verification in Task 14.

---

### Task 13: Profile deletion — `DELETE /api/me/face-profile`

**Files:**
- Create: `app/api/me/face-profile/route.ts`
- Create: `components/profile/DeleteFaceProfileButton.tsx`
- Create: `tests/api/face-profile-delete.test.ts`

**Step 1: Implement DELETE** — auth required; in a single transaction:
1. Null out `users.face_embedding`, `users.face_quality_score`, `users.face_enrolled_at`.
2. Delete all `face_enrollment_frames` rows for the user.
3. Delete all `user_event_matches` rows for the user.
4. Insert `audit_events` row of kind `face_profile_deleted` (records both the withdrawal of biometric consent and the deletion; declines/deletions are audit events, not `consent_acceptances` rows).

**Step 2: UI button** — confirms via the delete-consent modal copy from Task 2, then calls DELETE; on success, refresh the profile page.

**Step 3: Test** — enroll a user (or seed all four kinds of rows), call DELETE, assert all four side effects.

**Step 4: Commit.**

**Expected output:** A user can fully erase their biometric footprint from the app.

**Verification:** Vitest test asserts row counts pre/post.

**Privacy posture documented here (cross-references Phase 6):**
- Account-level enrollment persists indefinitely until the user invokes this endpoint OR full account deletion happens.
- Per-event match rows in `user_event_matches` are also cleaned up by Phase 6's expiry cron when the event itself expires (separate trigger from this endpoint).
- `face_enrollment_frames` rows are *only* deleted by this endpoint; they are not event-scoped.
- Raw enrollment image frames in R2 were already deleted in Task 9 immediately after embedding extraction; nothing to clean up here.

**Note (Phase 6 follow-up):** When Phase 6 ships `lib/account/cascade-delete.ts`, this route is refactored to call `cascadeDelete({ userId, kind: 'face_profile_only' })` rather than duplicating the cascade logic inline. The endpoint URL (`DELETE /api/me/face-profile`) stays the same; only the implementation is extracted. Tracked as Phase 6 follow-up.

---

### Task 14: Device-tier QA — manual enrollment on every tier from the device protocol

**Files:**
- Create: `docs/qa/2026-XX-XX-phase4-enrollment-device-results.md` (results doc; not a code file)

**Tiers to cover** (one device each, latest OS):
1. **iOS Safari** — iPhone in browser, not installed.
2. **iOS PWA** — same iPhone, installed via "Add to Home Screen."
3. **Android Chrome** — modern Android phone.
4. **Android Chrome PWA** — same device, installed.

**For each tier, run this script:**

1. Load `/events/:id/enroll` while signed in and a member of the event.
2. Confirm the consent modal renders with the legal-review banner visible.
3. Accept consent. Confirm the camera preview activates.
4. Walk through all 7 angle prompts. Note: any dropped frames, exposure lockups, orientation-switch breakage (per device protocol §1).
5. Submit. Observe upload progress, then the result screen.
6. On success, navigate to the gallery and confirm at least one banded result is visible (or "no matches yet" if the event has no clusters covering this user).
7. Return to profile and execute "Delete face profile." Confirm the success state and that re-running enrollment is possible.

**Record per device:**
- Did capture complete in under 60s?
- Did orientation flip mid-session break the stream?
- Did the canvas fallback produce a correctly-oriented JPEG (no upside-down faces)?
- Did the PWA-installed version re-prompt for camera permission separately from Safari? (Document, do not fix — that's a known iOS PWA behavior.)
- Any console errors or network failures?

**Exit:** All four tiers produce a successful end-to-end enrollment and at least one match (or a verified "no clusters in this event yet" state).

**Verification:** Filled-in results table committed to `docs/qa/`. Issues filed for any tier-1 failure; Phase 4 cannot exit until tier failures are either fixed or re-classified as known limitations with explicit product sign-off.

---

### Task 15: Phase 4 review checkpoint

**Steps:**
1. Invoke `superpowers:requesting-code-review` and resolve all Critical / Important findings.
2. Confirm both gated decisions are now resolved:
   - `MATCH_THRESHOLD` and `MAYBE_THRESHOLD` are real values from Milestone 0 benchmark, not the provisional 0.55/0.42 defaults. Remove the `THRESHOLDS_PROVISIONAL` flag.
   - `consent-version` strings in `lib/consent/copy.ts` are updated to the legal-approved versions (e.g. `face-enroll-v1`, no `-DRAFT`). Remove the `LEGAL_REVIEW_REQUIRED` banner.
3. Confirm `audit_events` writes are happening on the four expected paths: consent decline (client-side fire), enrollment acceptance (Task 9), enrollment rejection (Task 9 failure path), profile deletion (Task 13).
4. Confirm Phase 5 dependencies are clear: gallery reads from `user_event_matches` with `band` field; "You" tab shows `match` rows; a `maybe_you` rendering decision is owned by Phase 5.
5. Run the full test suite + Playwright e2e once more.
6. Manual deploy to a preview environment and re-run one device tier (iOS Safari) end-to-end against real R2 + real worker.
7. Log Phase 4 sign-off in the project tracker; only then start Phase 5.

---

## Phase 4 review checkpoint — checklist

- [ ] All exit criteria 1-9 satisfied
- [ ] Both gated decisions resolved and provisional flags removed
- [ ] Per-tier device QA results table filled in (Task 14)
- [ ] `superpowers:requesting-code-review` complete; no open Critical/Important issues
- [ ] Phase 5 contract surface (`/api/events/:id/my-matches`, `user_event_matches` table) reviewed by whoever picks up the gallery work
- [ ] Privacy posture re-checked: enrollment frames gone from R2, centroid encrypted at rest, profile deletion verified
- [ ] Open questions list updated with answers chosen during the phase
- [ ] CI green on `main`
- [ ] One real test user (not the implementer) successfully enrolled on a non-iOS-Simulator phone

If any item is unchecked, do not start Phase 5.

# Photo Courier — Phase 4: Enrollment + Matching

> **⚠ Deferred — host-broadcast product line.** Active development is on **Pocket v0 / v1** (receiver-pooled product). See `docs/plans/2026-05-02-pocket-v0-implementation.md`. This phase plan is preserved for **Pocket Platform v2** — the original host-broadcast model — which is on hold pending Pocket v0 self-use results. Do not execute tasks here without re-confirming the product direction. Salvageable subsets for Pocket v1 are noted at the end of this document.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Source:** Expands the Phase 4 outline in `2026-04-27-photo-courier-implementation.md` to the same fidelity as Phase 1, informed by the Codex roadmap (`2026-04-27-photo-courier-implementation-codex.md` — Milestone 4) and the device caveats in `milestone-0-device-test-protocol.md`.

**Last revised:** 2026-05-03, after Phase 3 merged in `9f892b8`.

**Phase goal:** A user can give explicit consent, capture 5-7 face frames on iOS Safari / iOS PWA / Android Chrome, have those frames embedded by the Phase 3 worker, store a centroid `face_embedding`, and immediately see a banded `match` / `maybe you` / `no match` retrieval against pre-existing `face_clusters` in the current event — Personal mode only.

---

## End state of Phase 4

- A logged-in event member can launch a multi-angle capture flow that works on iOS Safari, iOS-installed PWA, and Android Chrome.
- An explicit consent modal (Legal-approved copy) blocks the camera stream until accepted; declining returns the user to the event landing page with no embedding side effects.
- The capture flow records 5-7 angle-prompted frames, posts them to an ephemeral R2 prefix, and calls a worker `POST /enroll` endpoint that returns `{ accepted, centroid, per_frame_embeddings, variance, quality_score, reject_reason }`.
- On `accepted: true`, the L2-normalized centroid is persisted to `users.face_embedding`; on rejection the user gets a "let's try that again" retry path with cause-specific messaging.
- Per-angle embeddings are persisted to a new `face_enrollment_frames` table for diagnostics. Raw frames are deleted from R2 immediately after the worker returns.
- A pgvector cosine-distance query against `face_clusters` (event-scoped, both sides L2-normalized) returns banded results: `match` (distance ≤ `match_max_distance`), `maybe_you` (between thresholds), `no_match` (above `maybe_max_distance`, dropped).
- A new `user_event_matches` table stores `(user_id, event_id, cluster_id, score, band)` so the gallery (Phase 5) can read matches without recomputing.
- A profile deletion endpoint immediately purges `users.face_embedding`, `face_enrollment_frames`, and `user_event_matches`.
- Personal-mode UI only. `open_pool` and `host_only` UI surfaces remain deferred to Phase 5.

---

## Exit criteria

Phase 4 is done when all of the following hold:

1. **Consent before camera** — Camera stream cannot start until the consent modal is accepted; accepting inserts a `consent_acceptances` row, declining inserts an `audit_events` entry. User is redirected on decline. Verified by Vitest API test + Playwright UI test.
2. **Multi-angle capture works on tier-1 devices** — A test user successfully completes enrollment end-to-end on at least one device per tier from `milestone-0-device-test-protocol.md`: iOS Safari (latest), iOS PWA (latest, installed), Android Chrome (latest). Captured manually, recorded in a results table.
3. **Worker `/enroll` implemented and contract-tested** — Worker no longer returns 501; `pytest worker/tests/test_enroll*.py` passes; Next.js mock-based contract test passes.
4. **Frames are ephemeral** — All raw enrollment frames are deleted from R2 before the API responds. Cleanup failure routes to `pending_r2_deletions` for Phase 6 to drain. Verified by integration tests covering both happy path and the cleanup-failure path.
5. **L2-normalization invariant holds** — `users.face_embedding`, `face_enrollment_frames.embedding`, and `face_clusters.representative_embedding` are all unit-norm. Verified by a SQL spot-check (`vector_norm(...)` within 1e-5 of 1.0) and unit tests on the cluster running-mean fix (Task 0).
6. **Banded matching returns at least three states** — For a synthetic test case with three known clusters at distances above/inside/below the threshold band, the matching API returns one `match`, one `maybe_you`, and excludes the third.
7. **Matches persist** — `user_event_matches` rows are written and re-readable; gallery queries in Phase 5 can join against this table without recomputing similarity.
8. **Profile deletion is destructive and audited** — `DELETE /api/me/face-profile` clears centroid, frame rows, match rows, and writes an `audit_events` row.
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
- Per-user enrollment rate limiting. Phase 4 ships unbounded retry; Phase 6 owns rate limiting alongside the rest of abuse prevention.
- Background re-trigger of `computeMatchesForUserEvent` after new clusters form. Phase 4 computes at enrollment; Phase 5 computes on gallery read (mandatory contract). A push/cron is Phase 6.
- Setting `face_clusters.claimed_by_user_id`. Canonical user→cluster mapping is `user_event_matches` rows where `band='match'`.

---

## Open questions

1. **Per-angle embedding retention period.** Default: keep `face_enrollment_frames` rows alongside the centroid until the user deletes their profile. Alternative: drop them after 30 days. Decide once we have an ML signal on whether re-centroid recompute is ever useful.
2. **`maybe_you` UX surface in gallery.** Phase 5 owns the actual rendering, but Phase 4 must decide whether to *return* `maybe_you` rows from the matching API. **Default: yes**, return them with a `band` field.
3. **Re-enrollment policy.** When a user with an existing `face_embedding` calls `/api/me/enroll`, do we 409 (force DELETE first) or overwrite? **Default: 409.** Re-derives a clean audit trail and avoids accidental degradation in worse lighting.

---

## Prerequisites — gated decisions that block Phase 4 coding

**Phase 3 status (merged 2026-05-03 in `9f892b8`):**
- Thresholds locked at `match_max_distance: 0.528`, `maybe_max_distance: 0.595` (cosine distance) — see caveat below.
- Per-event clustering job shipped at `lib/worker/cluster.ts` + `scripts/run-cluster-job.ts`.
- `lib/worker/client.ts` shipped (with `detectPhoto`); Phase 4 extends with `enrollFrames`.
- Worker dispatcher + runner shipped.
- `/enroll` reserved at 501 in `worker/main.py:138`.

Two of the original four blockers are resolved by Phase 3. Remaining gates:

| Decision | Owner | Unblocks | Default if unanswered when work starts |
|---|---|---|---|
| **Worker `/enroll` algorithm spec reviewed.** The "Worker `/enroll` algorithm" section below is signed off (rejection rules, normalization, quality formula). | Product + ML | Task 8 | **Block.** Without spec, "accepted: bool" is undefined. |
| **Consent wording** for: face enrollment modal, profile deletion modal, privacy policy paragraph on biometric data. | Legal + Product | Tasks 2, 3, 13 | **Placeholder copy with `LEGAL_REVIEW_REQUIRED` banner** visible in dev/staging; deployment to prod blocked by a pre-deploy check that fails if the banner is still present. |

### Known risks carried in from Phase 3 (not blockers, surfaced for Phase 4)

**1. LFW-only threshold tuning.** Per `docs/ops/threshold-decision-2026-04.md`: thresholds were tuned on 40 LFW celebrity press photos (well-lit, mostly frontal). Production data is amateur event photography. Phase 3 accepts the bias toward false negatives and sets a **retuning trigger: if recall < 0.7 in the first 100 beta users, retune on real beta-collected pairs.**

Phase 4 must:
- Surface this caveat as a comment in `lib/match/thresholds.ts`.
- Ensure `audit_events` carries `match_count` and `maybe_count` per `enrollment_accepted` so Phase 6 can compute recall.

**2. Cluster representative is not L2-normalized.** `lib/worker/cluster.ts:125` updates the running mean but never re-normalizes the result. Worker per-frame embeddings come back L2-normalized (`worker/recognition/embed.py:67-69`), but the running mean of unit vectors is not itself a unit vector. Bench thresholds were tuned on pure unit-norm vectors. **Phase 4 Task 0 patches this and backfills existing rows.** Without the fix, cosine distances via pgvector `<=>` are biased relative to the 0.528 / 0.595 thresholds and beta recall will be artificially low.

---

## Worker `/enroll` algorithm

This is the contract Phase 4's Task 8 implements. Both worker and client read it as the single source of "accepted" semantics.

**Inputs:** `{ frame_keys: string[] }` — R2 keys all under `enrollments/{userId}/{nonce}/`.

**Algorithm:**
1. For each `frame_key` (parallel via `asyncio.gather`):
   1. R2 GET (per-frame timeout 5s). On failure, mark `frame_status='r2_fetch_failed'` and skip.
   2. `cv2.imdecode`. Skip on decode failure with `frame_status='decode_failed'`.
   3. `Detector.detect(image)`. Accept iff `len(faces) == 1`. Skip with `frame_status='no_face'` or `'multiple_faces'` otherwise.
   4. `align_face(face, image)` → 112×112 aligned crop.
   5. `Embedder.embed(aligned)` → 128-d L2-normalized vector (already normalized by the embedder; assert norm).
2. Let `n = len(per_frame_embeddings)`. **Reject** with `reject_reason='too_few_valid_frames'` if `n < MIN_ACCEPTED_FRAMES` (default 4).
3. `centroid = mean(per_frame_embeddings, axis=0)`; **L2-normalize** the centroid.
4. `variance = mean(1 - dot(emb, centroid) for emb in per_frame_embeddings)` — mean cosine distance from each frame to centroid.
5. `quality_score = mean(det_confidence for emb in per_frame_embeddings)`.
6. **Reject** with `reject_reason='high_variance'` if `variance > MAX_ENROLL_VARIANCE` (default 0.15 — pending labeled tuning).
7. **Reject** with `reject_reason='low_quality'` if `quality_score < MIN_ENROLL_QUALITY` (default 0.70).
8. **Accept.**

**Invariants:**
- The centroid is L2-normalized. `face_clusters.representative_embedding` MUST also be L2-normalized (Task 0 ensures this).
- `accepted: true` iff `centroid` is a valid 128-d unit vector. On rejection, `centroid` is `null`.
- Response always includes `variance` and `quality_score` (even on rejection — clients use them for retry UX).
- All thresholds (`MIN_ACCEPTED_FRAMES`, `MAX_ENROLL_VARIANCE`, `MIN_ENROLL_QUALITY`) are env-tunable so ML can adjust without redeploy.

**Worker hard timeout:** 60s wall clock. Beyond that, return 200 with `{accepted: false, reject_reason: 'worker_timeout', variance: 0, quality_score: 0, centroid: null, per_frame_embeddings: []}` so the route's R2 cleanup still runs.

---

## Cross-phase contracts assumed

**Inputs from Phase 3 (recognition worker, all merged in `9f892b8`):**
- `POST /enroll` — currently 501; Phase 4 Task 8 implements per the algorithm above.
- `face_clusters` table populated by `lib/worker/cluster.ts` running every 2 minutes (`scripts/run-cluster-job.ts`). Schema has `representative_embedding vector(128)` and `event_id`.
- HMAC `X-Worker-Signature` shared with `WORKER_SECRET` (already used by `/detect`).
- `worker/config/thresholds.json` — locked. Phase 4's `lib/match/thresholds.ts` reads `match_max_distance` and `maybe_max_distance` as the **single source of truth**. Both are cosine *distance* (lower = closer). No env-var duplicate.
- `lib/worker/client.ts` — exists with `detectPhoto`. Phase 4 *extends* it with `enrollFrames`.

**Outputs to Phase 5 (gallery):**
- `users.face_embedding` populated for enrolled users (L2-normalized 128-d vector).
- `user_event_matches` table with `(user_id, event_id, cluster_id, score, band)`. **`score` is cosine distance, not similarity.** Lower = closer.
- `GET /api/events/:id/my-matches` endpoint that returns banded matches.
- `lib/match/computeForEvent.ts` exporting `computeMatchesForUserEvent(userId, eventId)`. **Phase 5's gallery API MUST call this on each gallery read** so matches stay current as new clusters form.
- **Visibility-mode enforcement is NOT in Phase 4.** This API trusts membership only; Phase 5's gallery layer gates `host_only` / `open_pool` UI.
- `consent_acceptances` rows referenced by Phase 6 compliance reporting.
- `face_clusters.claimed_by_user_id` is **left NULL by Phase 4.** Canonical user→cluster mapping is `user_event_matches` where `band='match'`.

---

## Tasks

### Task 0: Backfill — L2-normalize cluster representatives (Phase 3 carry-over fix)

**Why:** Phase 3 ships a clustering running mean (`lib/worker/cluster.ts:125`) that doesn't re-normalize. Per-frame embeddings come back L2-normalized from `worker/recognition/embed.py`, but the mean of unit vectors is not itself a unit vector. Bench thresholds (`0.528 / 0.595`) were tuned on unit-norm vectors. Without this patch, all Phase 4 matching is silently miscalibrated.

**Files:**
- Modify: `lib/worker/cluster.ts`
- Create: `tests/worker/cluster-normalization.test.ts`
- Create: `db/migrations/000X_backfill_cluster_representative_norm.sql` (manual SQL — no Drizzle change)

**Step 1: Patch the running mean.** In `lib/worker/cluster.ts`, after computing `newMean`:
```ts
const norm = Math.sqrt(newMean.reduce((s, v) => s + v * v, 0))
const normedMean = norm > 1e-6 ? newMean.map((v) => v / norm) : newMean
const newMeanLiteral = `[${normedMean.join(',')}]`
```
Same patch applies to the new-cluster INSERT path: the seed embedding is already normalized (it came from the worker), but assert that with a runtime check `if (Math.abs(norm - 1) > 1e-3) log.warn('cluster.seed.not_normalized')`.

**Step 2: Backfill migration.** A raw SQL migration that walks `face_clusters` rows and re-normalizes:
```sql
-- Re-normalize all existing cluster representatives to unit length.
-- Phase 3 running mean did not normalize; Phase 4 thresholds assume unit norm.
UPDATE face_clusters
SET representative_embedding = (
  SELECT array_to_vector(
    array_agg(elem / norm),
    128, false
  )
  FROM (
    SELECT unnest(representative_embedding::real[]) AS elem,
           sqrt((SELECT sum(power(unnest(representative_embedding::real[]), 2)))) AS norm
  ) sub
)
WHERE representative_embedding IS NOT NULL;
```
(If the SQL above is awkward — pgvector lacks built-in normalize — implement as a one-shot Node script `scripts/backfill-cluster-norm.ts` that loads each row, normalizes in JS, writes back. Acceptable since cluster count is small at MVP scale.)

**Step 3: Test.** `tests/worker/cluster-normalization.test.ts`:
- Seed two detections (unit vectors). Cluster them. Read back the representative; assert `vector_norm` within 1e-5 of 1.0.
- Add 5 more detections to the same cluster (running mean updates). Read back; assert still unit-norm.

**Step 4: Verify backfill on the dev DB.**
```sql
SELECT count(*) FROM face_clusters
WHERE abs(sqrt((SELECT sum(power(elem, 2)) FROM unnest(representative_embedding::real[]) AS elem)) - 1) > 1e-3;
```
Expected: 0.

**Step 5: Commit.**
```bash
git add lib/worker/cluster.ts tests/worker/cluster-normalization.test.ts db/migrations
git commit -m "fix(cluster): L2-normalize running-mean representative; backfill existing rows"
```

**Verification:** Test passes; backfill query reports 0 unnormalized rows.

---

### Task 1: Schema — `face_enrollment_frames`, `user_event_matches`, `consent_acceptances`, `audit_events`, `pending_r2_deletions` + `users.face_quality_score` type fix

**Files:**
- Modify: `db/schema.ts`
- Create: `db/migrations/000X_phase4_enrollment.sql` (auto-generated)

**Step 0: Fix `users.face_quality_score` column type.**

Phase 1 typed this as `integer`. The worker returns a float in `[0, 1]`. Storing 0.83 in `integer` truncates to `0` and the quality-gated retry path never fires.

```ts
// BEFORE: faceQualityScore: integer('face_quality_score'),
faceQualityScore: real('face_quality_score'),
```

Drizzle generates an `ALTER COLUMN ... TYPE real USING face_quality_score::real`. Verify destructive-safety: nothing populates this column before Phase 4 — no data loss. Add a CHECK to catch drift:
```sql
ALTER TABLE users ADD CONSTRAINT users_face_quality_score_range
  CHECK (face_quality_score IS NULL OR (face_quality_score >= 0 AND face_quality_score <= 1));
```

**Step 1: `face_enrollment_frames`**

```ts
export const faceEnrollmentFrames = pgTable('face_enrollment_frames', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  frameIndex: integer('frame_index').notNull(),         // 0..N-1
  anglePrompt: text('angle_prompt').notNull(),          // 'front' | 'left' | 'right' | 'up' | 'down' | 'mid_left' | 'mid_right'
  embedding: vector('embedding', 128).notNull(),        // L2-normalized
  qualityScore: real('quality_score'),                  // per-frame det confidence in [0,1]
  capturedAt: timestamp('captured_at').notNull().defaultNow(),
})
```

**Step 2: `user_event_matches`**

```ts
export const userEventMatches = pgTable('user_event_matches', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  clusterId: uuid('cluster_id').notNull(),
  score: real('score').notNull(),                       // cosine DISTANCE (matches worker/config/thresholds.json units)
  band: text('band', { enum: ['match', 'maybe_you'] }).notNull(),
  computedAt: timestamp('computed_at').notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.eventId, t.clusterId] }) }))
```

**Step 3: `consent_acceptances`** — generalized so Phase 6 only adds enum values (no migration).

```ts
export const consentAcceptances = pgTable('consent_acceptances', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  document: text('document', { enum: ['privacy_policy', 'terms_of_service', 'enrollment_biometric'] }).notNull(),
  version: text('version').notNull(),
  acceptedAt: timestamp('accepted_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
}, (t) => ({
  uniqAcceptance: uniqueIndex('consent_acceptances_user_doc_version_uniq').on(t.userId, t.document, t.version),
}))
```

**Step 4: `audit_events`**

```ts
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  payload: jsonb('payload'),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  byUser: index('audit_events_user_idx').on(t.userId),
  byKind: index('audit_events_kind_idx').on(t.kind, t.createdAt),
}))
```

**Step 5: `pending_r2_deletions`** — drained by Phase 6 cron; Phase 4 only writes rows when `deleteObject` fails after enrollment.

```ts
export const pendingR2Deletions = pgTable('pending_r2_deletions', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull(),
  reason: text('reason').notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
```

**Step 6: Generate + apply migration**
```bash
pnpm db:generate && pnpm db:migrate
```

**Verification:** all five tables visible in `pnpm db:studio`; `\d users` shows `face_quality_score` is `real` with the CHECK constraint.

---

### Task 2: Consent modal component (placeholder copy with legal-review banner)

**Files:**
- Create: `components/enroll/ConsentModal.tsx`
- Create: `lib/consent/copy.ts`
- Create: `tests/components/consent-modal.test.tsx`

**Step 1: Copy at `lib/consent/copy.ts`**

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

**Step 2: Modal at `components/enroll/ConsentModal.tsx`**

Render a `Dialog` (shadcn) that:
- Shows title + body
- Has Accept and Decline buttons
- On Accept: POSTs `/api/me/consent` with `{ document, version, decision: 'accepted' }`, then `onAccept()`
- On Decline: POSTs `/api/me/consent` with `{ document, version, decision: 'declined' }` (server-side audit), then `onDecline()`
- Renders a `LEGAL_REVIEW_REQUIRED` banner if `process.env.NEXT_PUBLIC_LEGAL_APPROVED !== '1'`

**Step 3: Test** — render modal, click Accept; assert fetch called with `decision:'accepted'`. Click Decline; assert fetch called with `decision:'declined'`. Assert banner visible when env unset.

**Step 4: Commit.**

---

### Task 3: API route — record consent decision (accept or decline)

**Files:**
- Create: `app/api/me/consent/route.ts`
- Create: `tests/api/consent.test.ts`

**Step 1: Tests**
- POST `{ document, version, decision: 'accepted' }` authed → 200; one row in `consent_acceptances` with `userId`, `ipAddress`, `userAgent`, `document`, `version`. Re-POST identical → no duplicate row.
- POST `{ document, version, decision: 'declined' }` authed → 200; **no** `consent_acceptances` row; one `audit_events` row with `kind='consent_declined'`, `userId`, `ipAddress`, `userAgent`, `payload = { document, version }`.
- POST without auth → 401.
- POST with invalid `decision` → 400.

**Step 2: Implement** — auth via `getCurrentUser`; capture IP from `x-forwarded-for` and UA from headers. Branch on `decision`:
- `accepted` → `INSERT ... ON CONFLICT (user_id, document, version) DO NOTHING` into `consent_acceptances`.
- `declined` → `INSERT INTO audit_events (kind='consent_declined', payload=jsonb)`.
Return `{ ok: true }`.

**Step 3: Commit.**

---

### Task 4: Capture-page scaffold + camera-stream hook

**Files:**
- Create: `app/(app)/events/[id]/enroll/page.tsx`
- Create: `components/enroll/CaptureSession.tsx`
- Create: `lib/camera/useCameraStream.ts`
- Create: `lib/camera/captureFrame.ts`
- Create: `tests/lib/captureFrame.test.ts`

**Step 1: `useCameraStream` hook** — `getUserMedia({ video: { facingMode: { ideal: 'user' } }, audio: false })`. Handles permission-denied, no-front-camera, stream-suspended (visibilitychange) per device protocol. Cleans up on unmount.

**Step 2: `captureFrame`** — always canvas path (iOS Safari lacks `ImageCapture`):

```ts
export async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
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

EXIF/orientation note (one comment): drawing the live `<video>` to canvas produces a JPEG with no rotated metadata; pixels are already in the user's apparent orientation. Sidesteps the iOS EXIF gotcha from device protocol §1.

**Step 3: Test** — mock `<video>` with `videoWidth`/`videoHeight` + `vitest-canvas-mock`. Assert `captureFrame` returns a non-empty `image/jpeg` Blob.

**Step 4: Capture page scaffold** — gates `<video>` behind the consent modal.

**Step 5: Commit.**

---

### Task 5: Multi-angle capture sequence UI

**Files:**
- Modify: `components/enroll/CaptureSession.tsx`
- Create: `lib/enroll/anglePrompts.ts`

**Step 1: Angles**
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

**Step 2: UI** — per prompt: show label, 3s countdown with live preview, capture via `captureFrame`, append. Progress bar (`3/7`). After last prompt, "Submit" button.

**Step 3: Orientation handling** — listen for `orientationchange`; pause prompts mid-rotation and ask the user to hold still until stream stabilizes.

**Step 4: Manual smoke test.**

**Step 5: Commit.**

---

### Task 6: API route — issue ephemeral R2 upload URLs

**Files:**
- Create: `app/api/me/enroll/upload-urls/route.ts`
- Create: `tests/api/enroll-upload-urls.test.ts`
- Modify: `lib/photos/r2.ts` to expose `presignEnrollmentPut(userId, frameIndex)` using prefix `enrollments/{userId}/{nonce}/{frameIndex}.jpg`.

**Step 1: Implement** — POST returns `{ nonce, urls: [{ key, putUrl }] * N }`. Each URL is short-lived (60s).

**Step 2: Integration test** — assert N URLs returned, all keys under `enrollments/{userId}/{nonce}/`.

**Step 3: Commit.**

---

### Task 7: Client uploads frames to R2

**Files:**
- Modify: `components/enroll/CaptureSession.tsx`
- Create: `lib/enroll/uploadFrames.ts`
- Create: `tests/lib/uploadFrames.test.ts`

**Step 1: `uploadFrames(blobs)`** — fetch `/api/me/enroll/upload-urls`, then PUT each Blob with `Content-Type: image/jpeg`. Returns `{ nonce, frameKeys }`.

**Step 2: Wire into CaptureSession Submit handler.**

**Step 3: Unit test** — mock fetch, assert each PUT has the right Content-Type.

**Step 4: Commit.**

---

### Task 8: Implement worker `POST /enroll`

> Phase 3 reserved the route at 501 (`worker/main.py:138`). This task fills it in per the "Worker `/enroll` algorithm" section.

**Files:**
- Create: `worker/api/enroll.py`, `worker/recognition/enroll.py`, `worker/tests/test_enroll.py`, `worker/tests/test_enroll_algorithm.py`, `worker/tests/fixtures/enroll/` (consented selfie set)
- Modify: `worker/main.py` (register handler; remove 501 stub)
- Create: `tests/contracts/worker-enroll.test.ts` (Next.js mock-based contract)

**Step 1: Algorithm helper at `worker/recognition/enroll.py`** — exports `compute_enrollment(images: list[ndarray]) → EnrollmentResult` implementing the algorithm verbatim. Reads `MIN_ACCEPTED_FRAMES`, `MAX_ENROLL_VARIANCE`, `MIN_ENROLL_QUALITY` from env vars with documented defaults.

**Step 2: Algorithm tests at `worker/tests/test_enroll_algorithm.py`**
- 4 frames of one consented identity → accepted; centroid unit-norm (`abs(np.linalg.norm(centroid) - 1.0) < 1e-5`); variance < 0.1.
- 2 frames → rejected `'too_few_valid_frames'`.
- 7 frames where 5 contain different identities → rejected `'high_variance'`.
- 5 low-confidence frames (mock detector conf=0.4) → rejected `'low_quality'`.
- Frame with 0 faces → skipped, not counted toward `n`.
- Frame with 2 faces → skipped (per spec: `len(faces) == 1`).

**Step 3: HTTP handler at `worker/api/enroll.py`**
- HMAC auth dependency reused from `/detect`.
- Pydantic request: `{ frame_keys: list[str] }` (length 1..16).
- Per key: R2 GET via `worker/api/r2.py` (5s per-frame timeout, parallelized). On GET failure, treat that frame as `'r2_fetch_failed'` and skip — don't fail the whole request unless `n < MIN_ACCEPTED_FRAMES`.
- Hand decoded images to `compute_enrollment`.
- Wrap in 60s `asyncio.wait_for`. On timeout: 200 with `{accepted: false, reject_reason: 'worker_timeout', variance: 0, quality_score: 0, centroid: null, per_frame_embeddings: []}`.

**Step 4: Endpoint tests at `worker/tests/test_enroll.py`**
- HMAC missing → 401.
- 5 consented fixture frames → 200, `accepted: true`, response shape valid, `len(centroid) == 128`, centroid unit-norm.
- 2 frames → 200, `accepted: false`, `reject_reason: 'too_few_valid_frames'`, `centroid: null`.
- One key 404s in R2 (mocked) → still succeeds if `n - 1 ≥ MIN_ACCEPTED_FRAMES`.

**Step 5: Next.js contract test** — mock `fetch` to return canned accept/reject payloads; assert `enrollFrames(...)` (Task 9) parses both correctly.

**Step 6: Fixtures** — `worker/tests/fixtures/enroll/` with 7 consented selfie frames from one team member + `CONSENT.md` per `bench/fixtures/labeled-template/`.

**Step 7: Commit.**

**Failure visibility:** every reject path emits `worker.enroll.rejected` with `{reject_reason, n_valid_frames, variance, quality_score}`. Successful enrolls emit `worker.enroll.accepted`.

---

### Task 9: API route — `POST /api/me/enroll` (orchestrates worker + persistence + cleanup)

**Files:**
- Create: `app/api/me/enroll/route.ts`
- Modify: `lib/worker/client.ts` (add `enrollFrames`)
- Create: `tests/api/enroll.test.ts`

**Step 1: Extend worker client.** Add `enrollFrames(frameKeys: string[]): Promise<EnrollResponse>` to `lib/worker/client.ts`. Reuses the existing HMAC helper. **Client-side timeout: 75s** (worker hard cap is 60s; 15s buffer for jitter). `EnrollResponse` matches the algorithm spec including `variance` and `quality_score` on both accept and reject.

**Step 2: Implement route**

1. `getCurrentUser`; require auth.
2. **Re-enrollment guard.** If `users.face_embedding IS NOT NULL`, return **409** `{ error: 'already_enrolled', hint: 'DELETE /api/me/face-profile first' }`. (Open Question 3 default.)
3. Confirm `consent_acceptances` row for `(user_id, 'enrollment_biometric', current_version)` where `current_version` is from `lib/consent/copy.ts`; reject **412** if not.
4. Validate `{ nonce, frameKeys, eventId }`. All keys must start with `enrollments/{userId}/{nonce}/`. Reject 400 on mismatch.
5. **Frame existence check.** `Promise.all(frameKeys.map(headObject))`. If any null or `contentLength === 0`, reject 400 `{ error: 'missing_frames', missing: [...] }`.
6. Wrap steps 7–10 in `try { ... } finally { await deleteFramesUnderNonce(userId, nonce) }`. **The finally MUST succeed.** If `deleteObject` throws, log `worker.enroll.r2_cleanup_failed` (error level), Sentry capture, AND insert into `pending_r2_deletions`. Privacy promise is non-negotiable.
7. Call `enrollFrames(frameKeys)`.
8. If `accepted: false`: insert `audit_events` `{kind: 'enrollment_rejected', payload: { reject_reason, variance, quality_score, n_attempted }}`. Return 200 `{ accepted: false, rejectReason, variance, qualityScore }`.
9. If `accepted: true`, in one transaction:
   - Update `users.face_embedding`, `users.face_quality_score`, `users.face_enrolled_at`.
   - Insert per-frame rows into `face_enrollment_frames`.
   - Trigger initial match recompute: `await computeMatchesForUserEvent(userId, eventId)` (Task 11). Capture `matches.length` and band counts.
   - Insert `audit_events` `{kind: 'enrollment_accepted', payload: { variance, quality_score, n_frames, match_count, maybe_count }}`. (`match_count` and `maybe_count` are required for the Phase 6 recall instrumentation flagged in "Known risks.")
10. Return 200 `{ accepted: true, qualityScore, matches }`.

**Step 3: Accept-path test** — mock worker → accepted. Assert all transactional side effects + R2 cleanup + `user_event_matches` populated for seeded clusters.

**Step 4: Reject-path test** — mock worker → `{accepted:false, rejectReason:'high_variance', variance:0.3, qualityScore:0.85}`. Assert no DB writes (other than audit), audit row carries variance/quality, R2 cleanup ran, response includes both numbers.

**Step 5: Already-enrolled test** — seed user with `face_embedding`; POST → 409, no side effects, no worker call.

**Step 6: R2 cleanup-failure test** — mock `deleteObject` to throw on one key. Assert `pending_r2_deletions` row written, error log emitted, response still 200 with worker verdict.

**Step 7: Worker timeout test** — mock client to throw timeout. Assert reject-path behavior with `rejectReason: 'worker_timeout'`.

**Step 8: Commit.**

---

### Task 10: API route — banded matching `GET /api/events/:id/my-matches`

**Files:**
- Create: `app/api/events/[id]/my-matches/route.ts`
- Create: `lib/match/thresholds.ts`
- Create: `tests/api/my-matches.test.ts`

**Step 1: Threshold loader at `lib/match/thresholds.ts`**

```ts
import thresholds from '../../worker/config/thresholds.json' assert { type: 'json' }

// Phase 3 (2026-05-03) locked these from a labeled bench eval. Caveat: dataset
// was 40 LFW celebrity press photos — well-lit, mostly frontal. Production
// data is amateur event photography, biasing errors toward false negatives.
// Phase 6 retunes if recall < 0.7 in first 100 beta users (per
// docs/ops/threshold-decision-2026-04.md).

if (
  typeof thresholds._note === 'string' &&
  thresholds._note.toUpperCase().includes('PLACEHOLDER')
) {
  throw new Error(
    'worker/config/thresholds.json contains PLACEHOLDER values. ' +
    'Phase 3 Task 11 must lock thresholds before Phase 4 matching ships.',
  )
}

export const MATCH_MAX_DISTANCE: number = thresholds.match_max_distance
export const MAYBE_MAX_DISTANCE: number = thresholds.maybe_max_distance
```

This is the **only** place Phase 4 reads thresholds. No env vars. No duplicates.

**Step 2: Implement route**

1. Auth + event-membership check (re-use Phase 1 pattern).
2. Load `users.face_embedding`; if null → return `{ enrolled: false, matches: [] }`.
3. Run pgvector cosine-distance query:
   ```sql
   SELECT id AS cluster_id,
          (representative_embedding <=> $userVec::vector) AS distance
   FROM face_clusters
   WHERE event_id = $eventId
   ORDER BY representative_embedding <=> $userVec::vector
   LIMIT 50;
   ```
4. Band each row using cosine *distance* (lower = closer):
   - `distance ≤ MATCH_MAX_DISTANCE` → `match`
   - `MATCH_MAX_DISTANCE < distance ≤ MAYBE_MAX_DISTANCE` → `maybe_you`
   - else → drop
5. **Upsert** banded rows into `user_event_matches` (`ON CONFLICT (user_id, event_id, cluster_id) DO UPDATE SET score = EXCLUDED.score, band = EXCLUDED.band, computed_at = now()`). `score` stored as cosine distance.
6. Return `{ enrolled: true, matches: [{ clusterId, score, band }] }` sorted ascending by score (best match first).

**Step 3: Test with fixture clusters** — seed three `face_clusters` rows at known cosine distances (just below `MATCH_MAX_DISTANCE`, between thresholds, above `MAYBE_MAX_DISTANCE`). Assert exactly 1 `match`, 1 `maybe_you`. Re-running is idempotent (same row count, updated `computed_at`).

**Step 4: "Not enrolled" test.**

**Step 5: PLACEHOLDER guard test** — mock `thresholds.json` to contain a `_note: 'PLACEHOLDER'`; assert importing `lib/match/thresholds.ts` throws.

**Step 6: Commit.**

---

### Task 11: Extract `computeMatchesForUserEvent` and trigger from enrollment

**Files:**
- Create: `lib/match/computeForEvent.ts`
- Modify: `app/api/events/[id]/my-matches/route.ts` (refactor to call the helper)
- Modify: `app/api/me/enroll/route.ts` (call inside the success transaction, per Task 9 step 9)

**Step 1: Extract** matching SQL + banding from Task 10 into `computeMatchesForUserEvent(userId, eventId): Promise<MatchRow[]>`. Reads thresholds from `lib/match/thresholds.ts`. Returns banded list AND has the upsert side effect.

**Step 2: Idempotency / debounce.** Process-local `Map<string, timestamp>` (LRU bounded at 1000 entries). Skip the SQL if `(userId, eventId)` was just computed within the last 2 seconds. Documents the staleness window for cross-process callers.

**Step 3: Wire into both routes.**

**Step 4: Test** — end-to-end: seed clusters, mock worker enroll → accepted, hit enroll endpoint, assert response includes matches and `user_event_matches` rows; immediately call `/my-matches` and assert debounce kicks in (spy on SQL client → zero calls within 2s).

**Step 5: Commit.**

---

### Task 12: Enrollment results UI

**Files:**
- Create: `components/enroll/EnrollmentResult.tsx`
- Modify: `app/(app)/events/[id]/enroll/page.tsx`

**Step 1: Render** — three states:
- **Accepted with matches:** "We found N photos that look like you, plus M more we're not sure about." CTA: "See my photos" → `/events/:id`.
- **Accepted, zero matches yet:** "Enrollment saved. We'll let you know when photos of you appear." CTA: "Back to event."
- **Rejected:** message keyed off `rejectReason` from Task 9's response (uses the `variance` and `qualityScore` for diagnostic flavor):
  - `too_few_valid_frames` → "We couldn't see your face clearly in enough of the photos. Let's try once more in better light."
  - `high_variance` → "Your photos looked too different from each other — try holding the phone steady and following the prompts more slowly."
  - `low_quality` → "The lighting or focus made these hard to read. Try moving somewhere brighter or holding the phone closer."
  - `worker_timeout` → "Something took longer than expected. Let's try once more."
  - default → "We couldn't get a clear read. Let's try once more."
  CTA: "Retry" → resets the capture session.

**Step 2: Manual smoke test.**

**Step 3: Commit.**

---

### Task 13: Profile deletion — `DELETE /api/me/face-profile`

**Files:**
- Create: `app/api/me/face-profile/route.ts`
- Create: `components/profile/DeleteFaceProfileButton.tsx`
- Create: `tests/api/face-profile-delete.test.ts`

**Step 1: Implement DELETE** — auth required; capture `ipAddress` (via Phase 2 `x-forwarded-for` helper) and `userAgent`. In one transaction:
1. Null out `users.face_embedding`, `users.face_quality_score`, `users.face_enrolled_at`.
2. Delete all `face_enrollment_frames` for the user.
3. Delete all `user_event_matches` for the user.
4. Insert `audit_events` `{kind: 'face_profile_deleted', userId, ipAddress, userAgent, payload: { rows_deleted: { frames: N, matches: M } }}`.

**Step 2: UI button** — confirms via `FACE_DELETE_CONSENT` modal; on success refreshes profile.

**Step 3: Test** — enroll a user (or seed all four kinds of rows); call DELETE; assert all four side effects.

**Step 4: Commit.**

**Privacy posture:**
- Account-level enrollment persists until this endpoint OR full account deletion runs.
- `user_event_matches` rows ALSO get cleaned by Phase 6's expiry cron when the event itself expires.
- `face_enrollment_frames` rows are deleted *only* by this endpoint.
- Raw R2 frames were already deleted in Task 9 immediately after embedding extraction.

**Phase 6 follow-up:** when `lib/account/cascade-delete.ts` lands, this route refactors to `cascadeDelete({ userId, kind: 'face_profile_only' })`. URL stays the same.

---

### Task 14: Device-tier QA — manual enrollment on every tier

**Files:**
- Create: `docs/qa/2026-XX-XX-phase4-enrollment-device-results.md`

**Tiers:**
1. iOS Safari — iPhone in browser, not installed.
2. iOS PWA — same iPhone, "Add to Home Screen."
3. Android Chrome — modern Android phone.
4. Android Chrome PWA — same device, installed.

**Per tier:**
1. Load `/events/:id/enroll` while signed in and a member.
2. Confirm consent modal renders with legal-review banner.
3. Accept consent. Confirm camera preview activates.
4. Walk through all 7 angle prompts. Note dropped frames, exposure lockups, orientation-switch breakage.
5. Submit. Observe upload progress, then result screen.
6. On success, navigate to gallery; confirm at least one banded result OR "no matches yet" if no clusters.
7. Return to profile and execute "Delete face profile." Confirm success state and that re-enrollment is possible.

**Record per device:**
- Capture under 60s?
- Orientation flip mid-session break the stream?
- Canvas fallback produced a correctly-oriented JPEG?
- PWA-installed re-prompt for camera permission separately from Safari? (Document, do not fix.)
- Console errors or network failures?

**Exit:** All four tiers produce a successful end-to-end enrollment AND at least one match (or verified "no clusters yet").

---

### Task 15: Phase 4 review checkpoint

1. Invoke `superpowers:requesting-code-review` and resolve all Critical / Important findings.
2. Confirm gated decisions resolved:
   - `worker/config/thresholds.json` no longer contains PLACEHOLDER (already done by Phase 3; `lib/match/thresholds.ts` boots without throwing).
   - `consent-version` strings in `lib/consent/copy.ts` are legal-approved (e.g. `face-enroll-v1`, no `-DRAFT`). Remove `LEGAL_REVIEW_REQUIRED` banner.
3. Confirm `audit_events` writes happen on the five expected paths: consent decline (Task 3), enrollment acceptance (Task 9 — including `match_count`/`maybe_count`), enrollment rejection (Task 9), R2 cleanup failure → `pending_r2_deletions` (Task 9), profile deletion (Task 13).
4. Confirm Phase 5 dependencies are clear: gallery reads from `user_event_matches` with `band` field; gallery API **calls `computeMatchesForUserEvent` on each read**; `maybe_you` rendering decision owned by Phase 5.
5. Confirm L2-normalization invariant via SQL spot-check:
   ```sql
   SELECT count(*) FROM face_clusters
   WHERE abs(sqrt((SELECT sum(power(elem, 2)) FROM unnest(representative_embedding::real[]) AS elem)) - 1) > 1e-3;
   ```
   Expected: 0. Same for `users.face_embedding` (where not null) and `face_enrollment_frames.embedding`.
6. Run full test suite + Playwright e2e.
7. Manual deploy to preview; re-run iOS Safari device tier end-to-end against real R2 + real worker.
8. Log Phase 4 sign-off; only then start Phase 5.

---

## Phase 4 review checkpoint — checklist

- [ ] All exit criteria 1-9 satisfied
- [ ] Both remaining kickoff prerequisites resolved (`/enroll` algorithm spec signed off, legal copy approved)
- [ ] Per-tier device QA results table filled in (Task 14)
- [ ] `superpowers:requesting-code-review` complete; no open Critical/Important issues
- [ ] Phase 5 contract surface (`/api/events/:id/my-matches`, `user_event_matches`, mandatory `computeMatchesForUserEvent` on each gallery read) reviewed by whoever picks up the gallery
- [ ] L2-normalization invariant spot-checked across `users.face_embedding`, `face_clusters.representative_embedding`, `face_enrollment_frames.embedding`
- [ ] Privacy posture re-checked: enrollment frames gone from R2, `pending_r2_deletions` empty (or has owners), profile deletion verified
- [ ] LFW-caveat instrumentation in place: `audit_events` enrollment_accepted carries `match_count`/`maybe_count` for Phase 6 recall computation
- [ ] Open questions list updated with answers chosen during the phase
- [ ] CI green on `main`
- [ ] One real test user (not the implementer) successfully enrolled on a non-iOS-Simulator phone

If any item is unchecked, do not start Phase 5.

---

## Salvageable for Pocket v1

If Pocket v0 self-use succeeds and v1 begins, these pieces of Phase 4 may be worth lifting:

- **L2-normalized embedding invariant** and the cluster running-mean fix — already shipped in Phase 3 worker; document the assumption here so v1 enrollment doesn't drift.
- **Consent acceptances table + audit_events table** — useful regardless of broadcast vs. receiver-pooled. Pocket v0 currently lacks both.
- **Frame-ephemeral cleanup pattern** (delete enrollment frames from R2 immediately after worker returns, with `pending_r2_deletions` fallback) — directly applicable to Pocket v1's owner enrollment.
- **Profile deletion endpoint** (`DELETE /api/me/face-profile`) — Pocket v0 has no deletion path yet. v1 needs this for privacy.

The multi-angle capture UX, banded matching API (`my-matches`), and `user_event_matches` table are NOT salvageable — Pocket uses single-selfie enrollment and a single You feed.

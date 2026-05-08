# Multi-angle Face Scan Enrollment + ArcFace R50 — Design

Date: 2026-05-07
Status: Design (v2 after adversarial review 2026-05-07)
Review log: `docs/plans/2026-05-07-face-scan-review-notes.md` (created from review pass)

## Problem

Single-selfie enrollment + 128-d SFace embeddings fails on real amateur event photos. Founder dogfood (2026-05-07):

- Self-no-glasses pair distance: 0.469
- Self-no-glasses vs self-no-glasses: 0.503
- Self-with-glasses vs self-no-glasses: **0.903**
- Not-self vs self: **0.981** — only 0.078 of margin from the glasses match

LFW-tuned threshold (0.528) caught 1/3 self photos. Relaxed to 0.92 as stop-gap (`worker/config/thresholds.json:8`), one bad photo from a wrong-person match. The dogfood note prescribes the v1 fix: multi-angle enrollment + better embedding model.

## Goals

- 3-angle guided face scan (frontal, yaw-left, yaw-right) replacing single-selfie.
- **Server-side yaw verification** from RetinaFace landmarks — UI cannot lie about pose.
- Per-angle embedding storage in a new `user_face_embeddings` table.
- Recognition model swap: SFace 128-d → InsightFace ArcFace R50 `w600k_r50.onnx` 512-d.
- pgvector dimension change on `face_detections.embedding` and `face_clusters.representative_embedding`.
- `listYouFeed` matches via MIN cosine distance over a user's enrollment embeddings.
- New thresholds tuned **against dogfood pairs** (LFW used only as sanity, not for production threshold).
- Force re-enroll all existing users (founder only). Force re-detect all existing photos.
- **Two-phase migration**: keep legacy columns through cutover; drop in a follow-up only after burn-in.

## Out of scope

- Liveness / anti-spoof.
- Continuous capture with browser-side pose estimation (MediaPipe FaceMesh wasm) — server-side yaw check is the gate; client UI just provides prompts.
- GPU/CoreML providers.
- Vector DB migration off pgvector.
- Up/down pitch angles.

## Architecture

### 1. Worker: model + preprocessing + landmarks

#### Embedding model

- New file: `worker/models/w600k_r50.onnx` (~166 MB, from InsightFace `buffalo_l` pack — same source as `det_10g.onnx` already extracted via `download_models.sh`).
- `worker/recognition/embed.py`:
  - `MODEL_FILENAME = "w600k_r50.onnx"`
  - `EMBEDDING_DIM = 512`
  - `_preprocess` — explicit pseudocode:
    ```python
    def _preprocess(face_bgr: np.ndarray) -> np.ndarray:
        if face_bgr.shape[:2] != INPUT_SIZE:
            face_bgr = cv2.resize(face_bgr, INPUT_SIZE, interpolation=cv2.INTER_LINEAR)
        face_rgb = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB).astype(np.float32)
        # InsightFace ArcFace pipeline: (pixel - 127.5) / 127.5  →  [-1, +1]
        blob = (face_rgb - 127.5) / 127.5
        # NCHW
        blob = blob.transpose(2, 0, 1)[np.newaxis]
        return blob
    ```
  - L2-normalization of model output is preserved (current `embed.py` already does this; ArcFace R50 outputs are *not* internally normalized, so the existing post-norm step is correct and stays).
- Mirror in `bench/src/embed.py` byte-identical (modulo the documented allow-listed `PROVIDERS` import shim and docstrings). The AST parity test (`test_bench_worker_parity.py`) gates this in CI.

#### FaceOut payload — add `yaw`

`worker/api/detect.py`:

```python
class FaceOut(BaseModel):
    bbox: tuple[float, float, float, float]
    confidence: float
    landmarks: list[tuple[float, float]] = Field(min_length=5, max_length=5)
    embedding: list[float] = Field(min_length=512, max_length=512)  # was 128
    yaw: float  # NEW — image-space signed score (not radians); 0 = frontal, > 0 = head turned to user's LEFT, < 0 = head turned to user's RIGHT
```

`yaw` computed in `worker/recognition/detect.py` (new helper) from the 5-point landmark set:

```python
def estimate_yaw(landmarks: list[tuple[float, float]]) -> float:
    eye_l, eye_r, nose, _, _ = landmarks
    eye_mid_x = (eye_l[0] + eye_r[0]) / 2.0
    eye_dx = abs(eye_r[0] - eye_l[0])
    if eye_dx < 1e-3:  # degenerate
        return 0.0
    # Normalized horizontal offset of the nose vs eye midpoint, signed.
    # Positive = nose shifted toward image-right (head turned to user's LEFT).
    return (nose[0] - eye_mid_x) / eye_dx
```

This is a coarse yaw proxy, not a calibrated radian. We treat the output as a signed unit-less score. Empirical buckets to tune at implementation:

- `|score| < 0.10` → frontal
- `score > 0.18` → user turned head to their LEFT (camera sees user's right side)
- `score < -0.18` → user turned head to their RIGHT

Final thresholds will be tuned during implementation by capturing the founder's frontal+left+right scans and printing scores. The 0.10 / 0.18 numbers are starting points.

The yaw proxy is also returned as part of FaceOut for downstream observability — every detection logs its pose, which lets us see in production whether contributor photos in event feeds skew toward extreme poses.

### 2. Storage

#### New table

```sql
CREATE TABLE user_face_embeddings (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  angle text NOT NULL,
  embedding vector(512) NOT NULL,
  quality_score integer NOT NULL,           -- detector confidence × 100
  yaw real NOT NULL,                        -- the score from estimate_yaw at enrollment
  preview_r2_key text NOT NULL,
  enrolled_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, angle),
  CONSTRAINT user_face_embeddings_angle_check
    CHECK (angle IN ('frontal','left','right'))
);

CREATE INDEX user_face_embeddings_user_id_idx ON user_face_embeddings(user_id);
```

Composite PK enforces idempotent re-enrollment of a single angle (UPSERT overwrites).

#### Legacy columns — kept through cutover

`users.face_embedding`, `users.face_quality_score`, `users.face_enrolled_at` are **kept** through this migration. They become unused but stay nullable. A follow-up migration after burn-in (≥1 week of clean operation) drops them. This bounds the rollback blast radius.

`users.face_embedding`'s vector dim must still change to 512 OR remain 128 + nullable. Cleaner choice: **drop and re-add as vector(512) NULL** in the same migration since it's already destructive, but the new code path never reads or writes it. It exists purely as a hardcoded "we kept the column for safety" marker.

Actually, simpler: leave `users.face_embedding` as `vector(128) NULL` — Postgres allows nullable columns of any vector dim regardless of pgvector indexes. The new code never reads it; the old code (if anything still touches it) reads `NULL`. Drop in follow-up migration.

**Decision:** leave the legacy 128-d column alone, just nullable. Don't touch its data. Source of truth is the new table.

#### Schema migration mechanics

pgvector cannot ALTER a vector column's dim without dropping data. Migration steps:

1. `BEGIN`
2. Pre-check: count rows in `face_detections`. If > 0, abort unless `ALLOW_REEMBED_RESET=yes`.
3. `DROP INDEX IF EXISTS face_detections_embedding_idx`.
4. `DROP TABLE face_detections, face_clusters CASCADE` — note: CASCADE handles the circular FK between them. (TRUNCATE alone won't bypass FK during ALTER COLUMN.)
5. Re-CREATE both tables with `vector(512)` columns and the same constraints/indexes.
6. `CREATE TABLE user_face_embeddings (...)` from above.
7. Set `users.face_embedding`, `users.face_quality_score`, `users.face_enrolled_at` to NULL for all rows (force re-enrollment guard).
8. Re-queue `detect` jobs for every photo whose pipeline succeeded:
   ```sql
   INSERT INTO photo_jobs (photo_id, kind, state)
   SELECT id, 'detect', 'queued'
   FROM photos
   WHERE processing_state IN ('ready', 'processing')
     AND deleted_at IS NULL
   ON CONFLICT DO NOTHING;
   ```
   The partial unique index `photo_jobs_photo_id_kind_active_uidx` blocks duplicates if there's already a queued/claimed/succeeded job for this photo+kind. Photos in `processing_state='processing'` whose jobs the migration leaves orphaned are handled in step 9.
9. Reset orphaned in-flight jobs:
   ```sql
   UPDATE photo_jobs
   SET state = 'failed', last_error = 'migration_reset_2026-05-07', failed_at = now(), updated_at = now()
   WHERE state = 'claimed';
   ```
   Then re-enqueue from step 8 for those photos. (The unique partial index permits re-queue once the prior row is `failed`.)
10. `COMMIT`.

#### Deploy sequence (because of in-flight workers)

The migration is destructive to live worker state. The deploy must serialize:

1. `fly scale count 0 -a phostro-worker` — drain the worker.
2. Wait for `claimed` jobs to drop to zero (poll `photo_jobs` table) or `claimedAt < now() - INTERVAL '60 seconds'` for safety.
3. Run migration. Steps 8–9 re-queue clean.
4. Deploy new worker image (with ArcFace model + 512-d preprocessing + yaw landmarks).
5. Deploy Vercel app (with new schema + 512-d FaceOut validator + new enrollment endpoints).
6. `fly scale count 1 -a phostro-worker` — bring worker back; it picks up re-queued jobs.

Coordinated deploy. Document this in `docs/ops/face-scan-deploy.md` (new) before running the migration.

### 3. Bench re-eval and threshold sourcing

The threshold-decision-2026-04 doc rightly flags LFW as poor proxy for amateur photos. Re-running the same eval at 512-d gives another likely-perfect-separation result that doesn't transfer. We'll use LFW as a **sanity check only** and source the production threshold from the founder's dogfood pairs, augmented by CALFW/CPLFW if time permits.

Acceptance criteria for the new thresholds (`docs/ops/threshold-decision-2026-05.md` — new):

- LFW perfect-separation must be preserved (sanity).
- Founder dogfood: self-with-glasses vs self-no-glasses → predicted < 0.55 cosine distance under ArcFace R50; not-self vs self → predicted > 0.85. **These are falsifiable.** The doc must record actual numbers post-re-embed and call out any miss.
- `match_max_distance` set to the larger of (a) within-identity max in the dogfood set, (b) the LFW within-identity max + 0.05 buffer for distribution shift.
- `maybe_max_distance` set 0.05 above match.

Initial guess (will be replaced by measurement): `match_max_distance ≈ 0.55`, `maybe_max_distance ≈ 0.60`. This is the ArcFace operating-point neighborhood for L2-normalized embeddings on Glint360K-trained R50.

Threshold doc updates the deployed `MATCH_MAX_DISTANCE` env on Fly + Vercel.

### 4. Enrollment API

#### `/api/me/face/init` — unchanged

Returns presigned PUT URL, key under `enrollment-pending/{userId}/{nonce}.bin`.

#### `/api/me/face/finalize` — extended

Body: `{ key: string, angle: 'frontal' | 'left' | 'right' }`.

Flow:
1. Validate caller owns the key prefix (existing).
2. Validate angle enum.
3. Head + fetch from R2 (existing).
4. Sharp `processImage` (existing).
5. Upload preview to `enrollment/{userId}/{angle}-{timestamp}.jpg`.
6. Worker `/detect` (returns `yaw` now).
7. Existing invariants: `detected === 1`, `confidence > 0.6`.
8. **New invariants:**
   - Pose-vs-claimed-angle check using `yaw` (sign convention pinned by
     `worker/tests/test_yaw_estimation.py`; landmarks[0] is image-left per
     `align.py`'s ARCFACE_TEMPLATE, so user-LEFT turn → nose moves image-right
     → yaw > 0):
     - `angle === 'frontal'` → require `|yaw| < 0.10`
     - `angle === 'left'` → require `yaw > +0.18` (head turned to user's left)
     - `angle === 'right'` → require `yaw < -0.18`
   - On mismatch, return 400 `{ error: 'wrong_pose', angle, yaw, expected }`.
   - **Quality gate against existing angles**: if any other angles are already enrolled, compute cosine distance from new embedding to each existing one. If ALL pairwise distances are < 0.20 (suspiciously similar — implies the user did not actually turn their head despite the pose check passing), return 400 `{ error: 'too_similar_to_existing', distances }` and prompt retake. (This is a belt-and-suspenders gate alongside the yaw check.)
9. UPSERT into `user_face_embeddings` (PK conflict updates row).
10. Response:
    ```ts
    {
      enrolledAngles: ('frontal'|'left'|'right')[],
      remainingAngles: ('frontal'|'left'|'right')[],
      qualityByAngle: Record<string, number>,
      yawByAngle: Record<string, number>
    }
    ```

#### `GET /api/me/face/status` — new

Required so the UI can recover state on cold load (the user may reload mid-flow):

```ts
GET /api/me/face/status
Response: {
  enrolled: boolean,             // 3/3 angles present
  enrolledAngles: ('frontal'|'left'|'right')[],
  remainingAngles: ('frontal'|'left'|'right')[]
}
```

#### Helper

`lib/auth/face-enrollment.ts`:

```ts
export async function getFaceEnrollment(userId: string): Promise<EnrollmentStatus>
```

Used by every page/route currently checking `user.faceEmbedding`. Migration of call sites:

- `app/(app)/pockets/[id]/page.tsx:31, 43`
- `app/api/pockets/route.ts:16`
- `app/api/pockets/[id]/you/route.ts:27`
- `app/api/test-login/route.ts:38` — special: this synthesizes embeddings for tests. Update to insert 3 rows of synthetic 512-d vectors into `user_face_embeddings` instead of one 128-d into `users.face_embedding`. Tests depend on this.

### 5. Enrollment UI

New: `components/FaceScanEnroll.tsx`, mounted at `/me/face/enroll` (new route `app/(app)/me/face/enroll/page.tsx`). Pocket page's "Add your selfie" link target updates here.

Flow:

1. **On mount**: `GET /api/me/face/status` to determine resume point. If already enrolled, redirect to `/`.
2. **Permissions + camera preview.** `getUserMedia({ video: { facingMode: 'user' }, audio: false })`. If denied, render file-input fallback (single file picker per angle, same backend flow).
3. **For each remaining angle in deterministic order `['frontal','left','right']`:**
   - Show prompt: "Look straight at the camera" / "Turn your head to the left" / "Turn your head to the right".
   - Capture button. On click: draw video frame to canvas → `canvas.toBlob('image/jpeg', 0.92)` → POST to `/api/me/face/init` → PUT to R2 → POST to `/api/me/face/finalize` with the angle.
   - Status panel handles each error type:
     - `no_face` → "Couldn't see your face — try moving closer"
     - `multiple_faces` → "Multiple people detected — make sure only you're in frame"
     - `wrong_pose` (with `yaw` and `expected`) → "Turn your head a bit more to the left/right" — uses yaw to give specific feedback
     - `too_similar_to_existing` → "This looks the same as your last shot — turn your head more"
     - generic → "Something went wrong, try again"
   - Allow up to 5 consecutive failures per angle, then offer "Skip" (records the failure + tells the user enrollment is incomplete; they can retry later). This avoids a stuck loop.
4. **Success on third angle** → toast "All set" → redirect to `?next=` URL or `/`.

Progress indicator: `[●][○][○] 1 of 3 — Frontal` style.

### 6. Matching: listYouFeed

Switch from `ownerEmbedding: number[]` to `ownerEmbeddings: number[][]` (length 3 in v1, but keep the API generic).

The pgvector `unnest(::vector[])` form does not work — pgvector does not register a working array type for vectors. Use **N independent parameterized distance expressions and `LEAST` aggregated**, which preserves IVFFlat usability per term and parameterizes cleanly through Drizzle's `sql` template:

```ts
async function listYouFeed(eventId: string, ownerEmbeddings: number[][]): Promise<YouFeedItem[]> {
  // Pad to 3 entries — the SQL is shaped for 3, dup if fewer (idempotent: LEAST(d,d,d)=d).
  const [e1, e2, e3] = padToThree(ownerEmbeddings)
  const l1 = `[${e1.join(',')}]`
  const l2 = `[${e2.join(',')}]`
  const l3 = `[${e3.join(',')}]`
  const threshold = getMatchMaxDistance()
  const rows = await db.execute(sql`
    SELECT p.id AS photo_id,
           p.r2_key_preview,
           p.taken_at,
           MIN(LEAST(
             fd.embedding <=> ${l1}::vector,
             fd.embedding <=> ${l2}::vector,
             fd.embedding <=> ${l3}::vector
           )) AS distance
    FROM photos p
    JOIN face_detections fd ON fd.photo_id = p.id
    WHERE p.event_id = ${eventId}
      AND p.processing_state = 'ready'
      AND p.deleted_at IS NULL
    GROUP BY p.id, p.r2_key_preview, p.taken_at
    HAVING MIN(LEAST(
      fd.embedding <=> ${l1}::vector,
      fd.embedding <=> ${l2}::vector,
      fd.embedding <=> ${l3}::vector
    )) < ${threshold}
    ORDER BY p.taken_at DESC NULLS LAST, p.id ASC
  `)
  // ...
}
```

#### IVFFlat usage

`MIN(LEAST(...))` with all three distances projected per row computes 3 distances per detection; the IVFFlat index is bypassed (planner falls back to seq scan over the partial filter `p.event_id = $1 AND p.processing_state = 'ready'`). At v0/v1 scale this is fine — the perf test target is < 1500ms with 100 detections.

If perf budget breaks at scale: rewrite as 3 separate `ORDER BY ... <=> $constant LIMIT k` index probes per angle, union in app code, dedupe by `photo_id` and take MIN distance. Defer until measured.

The `WHERE` clause partial filter (event + state) bounds the row set; expensive cross-event scans don't happen.

### 7. Cluster job

`lib/worker/cluster.ts` works unchanged at 512-d. Running-mean update (`oldMean.map((v, i) => (v * oldCount + embedding[i]) / newCount)`) is dim-agnostic. After migration, all `face_clusters` rows are dropped (CASCADE in migration step 4). Cluster job re-seeds from re-detected `face_detections`.

Smoke test: post-re-detection, run `runClusterJob` against the founder's dogfood event and confirm cluster count is sensible.

### 8. Tests

Worker (Python):

- `worker/tests/test_review_fixes.py` — update FaceOut length tests from 128 → 512. Add tests for the new `yaw` field shape (float, finite).
- `worker/tests/test_detect_endpoint.py` — update mock embedder to return 512-d. Add test: `/detect` response includes `yaw` for each face.
- `worker/tests/test_recognition_smoke.py` — embedding shape `(512,)`.
- `worker/tests/test_bench_worker_parity.py` — should still pass; both files updated identically. The test's allow-list (PROVIDERS shim, docstrings) is unchanged.
- New: `worker/tests/test_yaw_estimation.py` — synthetic landmark fixtures for frontal/left/right cases, assert sign and approximate magnitude.

App (TypeScript):

- `tests/api/me-face.test.ts` — extend for `angle` param, `wrong_pose` error path, `too_similar_to_existing` path, UPSERT idempotency, status endpoint.
- `tests/api/me-face-status.test.ts` (new) — status endpoint behaviors.
- `tests/photos/you-feed.test.ts` (new or extend) — multi-embedding match, MIN-distance, threshold respected, single-angle case (during partial-enrollment edge case).
- `tests/worker/cluster.test.ts` — fixture embeddings to 512-d. Algorithm unchanged.
- `tests/auth/face-enrollment.test.ts` (new) — `getFaceEnrollment` helper.
- `tests/api/test-login.test.ts` — update synthetic-embedding seeding.

E2E:

- `e2e/pocket-owner.spec.ts` — extend "first run" to walk the 3-angle scan UI. Use file-input fallback (no real camera in headless Playwright). Stub worker `/detect` responses so CI doesn't download models.
- New: `e2e/face-scan.spec.ts` — wrong-pose rejection, too-similar rejection, mid-flow reload + resume.

### 9. Cold-start

Current p95 cold-start is 1.32s with 53 MB models loaded (see `docs/ops/worker-coldstart-2026-04.md`). Adding a 166 MB ArcFace model — measured loading time conservatively scales superlinearly with model size on cold disk:

- Page-cache-warm: +0.5–1.0s p95 (linear by file read)
- Cold disk on Fly volume: +1.5–3.0s p95 (volume read + ONNX op-graph init for ResNet-50)

Measure on Fly post-deploy. Update `docs/ops/worker-coldstart-2026-04.md` with actual numbers. Budget is 5s p95 at the worker — if exceeded, options: (a) scale-from-zero off (always-on), (b) lazy-load recognition model on first `/detect` (defers cold-start cost to first request).

### 10. Observability

New events emitted from `/api/me/face/finalize`:

- `face.enroll.angle.success` { userId, angle, qualityScore, yaw }
- `face.enroll.angle.reject_no_face` { userId, angle, detected }
- `face.enroll.angle.reject_multiple` { userId, angle, detected }
- `face.enroll.angle.reject_wrong_pose` { userId, angle, yaw, expected }
- `face.enroll.angle.reject_too_similar` { userId, angle, distances }

New event from `/api/me/face/status`: `face.enroll.status_check` { userId, enrolledAngles }

New gauge in cluster job: per-event embedding-dim sanity check (alarm if 128-d row leaks back in, defense in depth post-migration).

Cluster job + you-feed already emit run-completion logs; no changes there.

## Predicted dogfood outcomes (falsifiable)

After re-embed under ArcFace R50:

- Founder self-with-glasses vs self-no-glasses pair: distance < 0.55
- Founder self-no-glasses vs self-no-glasses pair: distance < 0.40
- Not-self vs self pair: distance > 0.85

If any of these fail, the design's theory of recall improvement is wrong; investigate before proceeding to UX polish or threshold lock-in. Write actual numbers into `docs/ops/threshold-decision-2026-05.md` as part of acceptance.

## Risks

1. **Threshold not yet measured.** The 0.55 / 0.85 numbers above are predictions, not measurements. Mandatory acceptance step.
2. **Yaw proxy may not generalize.** The 5-point landmark proxy is coarse and depends on RetinaFace's landmark accuracy under amateur lighting. Mitigations: tune empirical thresholds during implementation against founder captures; emit yaw in observability so production drift is visible.
3. **Cold-start growth.** +1.5–3.0s on Fly cold disk is plausible. Measure and decide whether to switch to always-on.
4. **Migration is destructive.** Two-phase approach + env guard limits blast radius, but data loss is real (all face_detections wiped). No production users yet → acceptable.
5. **Coordinated deploy.** Worker scale-down → migration → image deploy → scale-up sequence must be followed. Document in `docs/ops/face-scan-deploy.md`.
6. **Bench parity discipline.** Both `worker/recognition/embed.py` and `bench/src/embed.py` change in lockstep, single commit. Anything else and the AST parity test fails (correctly).
7. **Quality gate against existing angles** (the `too_similar_to_existing` check) may produce false-rejections if a user's face is genuinely similar across poses (e.g. a user with very symmetric features). The threshold (0.20) is conservative starting point; tune.

## Decisions log

- **Per-angle vs centroid storage**: per-angle. Centroid loses information when one extreme angle matches a target photo better than the average. Per-angle costs negligible storage and 3× distance computations per match (acceptable at v0/v1 scale).
- **Number of angles**: 3 (frontal, left, right). Up/down deferred — amateur event photos dominated by horizontal pose variation.
- **Server-side pose check**: yes. Without it, manual UI prompts are unenforceable and "multi-angle" reduces to "three frontal frames", which is no improvement over single-selfie. The yaw proxy is coarse but sufficient.
- **Two-phase migration vs single migration**: two-phase. Keep `users.face_embedding` columns through cutover; drop in follow-up after burn-in.
- **Liveness anti-spoof**: out of scope. Threat model is recall.
- **Embedding model**: ArcFace R50 (`w600k_r50.onnx` from buffalo_l). AdaFace candidate rejected: ArcFace shares packaging path with detection model already in use; simpler ops. Re-visit if dogfood shows AdaFace would meaningfully outperform.
- **Threshold source**: dogfood pairs primary, LFW sanity-only. The threshold-decision-2026-04 LFW limitations explicitly do not transfer to a model swap.
- **`unnest(::vector[])` SQL**: rejected (doesn't work in pgvector). Use `LEAST` over N parameterized `<=>` distances.
- **IVFFlat usage in matching**: bypassed by `LEAST` aggregation. Acceptable at scale; documented escape hatch (3 separate index probes + app-side dedup) if perf budget breaks.

## Implementation order

1. **Worker model swap.** Update `embed.py` + `bench/src/embed.py` (lockstep), `_preprocess`, `EMBEDDING_DIM`, FaceOut validator. Add `estimate_yaw` + return in FaceOut. Update `download_models.sh` for `w600k_r50.onnx`. Update tests.
2. **Bench re-eval.** Run `phostro-bench eval-labeled` for sanity. Capture founder dogfood pairs against new model. Write `docs/ops/threshold-decision-2026-05.md`. Update `worker/config/thresholds.json` and Fly + Vercel `MATCH_MAX_DISTANCE` env.
3. **DB migration.** New table, schema changes, re-queue jobs. Test on a copy of dev DB first. Document the deploy sequence.
4. **Enrollment API.** `/finalize` extension, `/status` new, helper, observability events.
5. **Enrollment UI.** `FaceScanEnroll` component + new route. File-input fallback. Status-driven resume on reload.
6. **Matching.** `listYouFeed` multi-embedding update. Update all call sites of `user.faceEmbedding` to use the helper.
7. **Tests.** Update + new. Run full suite locally.
8. **Local end-to-end.** Founder re-enrolls on dev. Verify yaw enforcement. Verify post-re-embed dogfood numbers match predictions.
9. **Coordinated deploy.** Per `docs/ops/face-scan-deploy.md`.
10. **Acceptance.** Founder smoke-test on prod. Cold-start measured on Fly. Threshold doc finalized with real numbers.

# Photo Courier — Phase 3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Date:** 2026-04-27
**Phase:** 3 — Recognition Pipeline
**Status:** Ready for implementation; threshold values pending labeled bench eval (Task 11)
**Predecessor:** Phase 2 (Upload + Storage). Successor: Phase 4 (Enrollment + Matching).

---

## End state of Phase 3

Every photo registered through the Phase 2 upload flow is processed by a Python FastAPI recognition worker that detects faces (RetinaFace `det_10g.onnx`) and computes 128-dimensional SFace embeddings, persisting `face_detections` rows and event-scoped `face_clusters` rows in Postgres with a Postgres-backed `photo_jobs` queue (no SQS), retried on transient failure with bounded attempts and a dead-letter state, observable via structured logs and a `failed_photo_jobs_recent` SQL view, runnable locally via `docker-compose up worker` and on a CI smoke job, with the `Photo.has_detected_faces` flag flipped exactly once per photo. The worker exposes the same `detect`/`embed` interfaces used by `bench/src/`, the production matching thresholds are locked from a labeled bench run rather than the current synthetic-fixtures placeholders, and worker cold-start latency on the chosen host is measured before the worker is shipped to a preview environment.

---

## Exit criteria

Phase 3 is complete when **all** hold:

1. **End-to-end async ingest** — uploading a real JPEG via the Phase 2 flow results in `≥1` `face_detections` row (or `has_detected_faces=false` if no face) within 60s on a single worker, with the originating `photo_jobs` row in `state='succeeded'`. Verified by an integration test (`tests/integration/photo-job-roundtrip.test.ts`) and a manual smoke run against a Neon preview branch.
2. **Worker contract tested** — `worker/tests/test_detect_endpoint.py` passes pytest with golden fixtures from `bench/fixtures/group_shot/`, asserting bbox count and embedding-dimension shape (128).
3. **Failure visibility** — a deliberately corrupted photo (zero-byte R2 object) drives a `photo_jobs` row to `state='failed'` after `max_attempts` retries with `last_error` populated; appears in `SELECT * FROM failed_photo_jobs_recent` and emits a `worker.job.failed` structured log captured by CI.
4. **Production thresholds locked** — `eval-labeled` has been run on a labeled identity dataset; the `match`/`maybe`/`no_match` cosine-distance thresholds are committed in `worker/config/thresholds.json` with the labeled `labeled_report.md` report linked from the commit message. Placeholder thresholds (0.582 / 0.6849) are explicitly replaced.
5. **Cold-start measured** — `docs/ops/worker-coldstart-2026-XX.md` records p50/p95 first-request latency on the chosen worker host (Fly.io and Railway both measured), informing the Phase 1 deferred deploy decision.
6. **Local dev parity** — `docker-compose up` brings up Postgres+pgvector, Next.js, and the worker; `pnpm test:integration` passes against this stack.
7. **Internal auth** — every Next.js → worker call carries an HMAC `X-Worker-Signature` header; unsigned requests return 401; verified by `worker/tests/test_auth.py`.
8. **No silent jobs** — every `photo_jobs` row reaches a terminal state (`succeeded` or `failed`) within `claim_timeout`; a watchdog query reclaims rows whose `claimed_at` is older than the timeout. Integration test simulates a worker crash mid-claim.
9. **CI green** — GitHub Actions runs both pnpm tests and pytest worker tests against the worker's Docker image; build pushes a tagged image to a registry (or local-only if no registry yet, but the `docker build` step must pass).

---

## Explicitly deferred — not in Phase 3

These belong to Phase 4 or later. Do **not** unblock them here.

- Multi-angle enrollment capture UX, MediaPipe Face Mesh guidance, consent modal copy (Phase 4).
- The `/enroll` worker endpoint behavior beyond a stub returning 501 (Phase 4 fills it in once enrollment UI exists). The endpoint *route* exists from Phase 3 so the contract is locked; the implementation is Phase 4.
- `User.face_embedding` writes — Phase 3 only writes `face_detections` rows and event-scoped clusters; user-level face profiles come from explicit enrollment in Phase 4, not from regular event-photo uploads.
- pgvector `<=>` retrieval queries for "photos of you" — Phase 4.
- `FaceCluster.claimed_by_user_id`, `representative_thumb` — Phase 4 wires these once enrollment lands.
- Gallery tabs, diff downloads, `PhotoView`/`PhotoSave` (Phase 5).
- Notification triggers, `T+5min` first-match emails (Phase 6).
- Cross-event face clustering (never; per-event scope is a privacy invariant).
- GPU acceleration / `CoreMLExecutionProvider` / `CUDAExecutionProvider` — CPU-only at launch, swap is a single-line change in `worker/recognition/providers.py`.
- Switching to SQS / a hosted queue — revisit only if `photo_jobs` polling becomes a measurable bottleneck.
- A full admin UI for failed jobs — Phase 3 ships the SQL view and structured logs only.
- PhotoDNA / Safer integration (post-MVP).

---

## Kickoff decisions resolved on 2026-05-01

1. **What Phase 3 actually does:** Phase 3 is the **photo-side recognition pipeline only**. It consumes Phase 2 `ready` photos, enqueues async `detect` jobs, runs detection + alignment + 128-d embedding extraction on the preview asset, writes `face_detections` plus event-scoped `face_clusters`, and flips `photos.has_detected_faces`. It does **not** populate `users.face_embedding`, run "photos of you" retrieval queries, or ship attendee enrollment UX; those remain Phase 4 work.
2. **Recognition library / runtime:** Stay with the repo's existing **Python + ONNX Runtime** lane: RetinaFace `det_10g.onnx` for detection plus SFace `face_recognition_sface_2021dec.onnx` for embeddings, exposed through the FastAPI worker and reusing `bench/src/detect.py` + `bench/src/embed.py`. Do **not** switch Phase 3 to `face-api.js`, `@vladmandic/face-api`, AWS Rekognition, or Cloudflare Workers AI. The current bench harness, thresholding workflow, and privacy posture are already built around the self-hosted ONNX path; changing stacks here would fork the evaluation lane and add avoidable vendor/runtime surface before beta.
3. **Sync vs async:** Recognition is **async**. `POST /api/events/:id/photos/:photoId/finalize` stays Phase 2's synchronous upload→preview step. Phase 3 begins only after finalize marks the photo `ready` and enqueues a `photo_jobs` row. Detection/embedding/clustering run in the worker so retries, crash recovery, dead-lettering, and operator visibility all live outside the attendee request path.
4. **Self-enrollment flow:** Enrollment is **explicit and separate** from normal uploads. The canonical `users.face_embedding` is created by the Phase 4 consented multi-angle enrollment flow (`POST /enroll` over ephemeral selfie frames), not during sign-in and not by mining a user's first uploaded event photo. Attendees can upload without enrolling; enrollment is triggered when they opt into the "You" retrieval flow.
5. **Which draft to start from:** Use **this document** as the Phase 3 starting point. `docs/plans/2026-04-27-photo-courier-phase-3.md` is the working baseline because it already reconciles earlier plan drift against current main (for example: `photo_jobs` was not actually shipped in Phase 2). Earlier Phase 2 / implementation docs remain rationale and cross-checks, not the execution source of truth.

---

## Open questions (carrying into Phase 3)

1. **R2 byte transport**: confirm worker-pulls-from-R2 (this plan's assumption) before starting Task 8. If reviewers prefer Next.js-pushes-bytes, swap Task 8's contract.
2. **Preview ownership**: confirm Phase 2 generates the preview before this plan's Task 8 runs. If Phase 2 deferred preview generation, Task 8 must accept the original.
3. **Worker host**: Fly.io vs. Railway. Decided after Task 1 (cold-start measurement).
4. **Concurrency target**: locked after Task 1 saturation measurement.
5. **`face_clusters.representative_embedding` recompute cadence**: every N detections, every 2 minutes, or both? Phase 3 ships a 2-minute cadence; revisit if cluster drift is observable in beta.
6. **Same-photo dedup**: should the worker skip a photo whose SHA-256 already has detections (resubmission case)? Phase 3 leans yes via a unique constraint on `photo_jobs.photo_id` for non-failed states; flag for review.

---

## Cross-phase contracts

**Phase 2 produces (consumed by Phase 3) — verified against current main:**
- `photos` table rows with `id`, `event_id`, `uploader_user_id`, `r2_key_original`, `r2_key_preview`, `width`, `height`, `taken_at`, `has_detected_faces=null`. ✓
- `photos.processing_state` ∈ `{pending, processing, ready, failed}` tracking the *upload→preview* state machine. **This column belongs to Phase 2.** Phase 3 only *reads* it (claim photos where `processing_state='ready'`); Phase 3 must never write to it.
- `lib/photos/r2.ts` exposing `createPresignedGetUrl(key, ttl)`, `getObjectBuffer(key)`, `putObject(key, body, contentType)`, `deleteObject(key)`. Phase 3 imports these (note: not `lib/r2/client.ts:presignGet` as earlier drafts said).
- `app/api/events/[id]/photos/[photoId]/finalize/route.ts` runs Sharp synchronously and sets `processing_state='ready'` on success. **Phase 3 edits this route to call `enqueuePhotoJob(photoId)` after the `ready` update succeeds** — Phase 2 did not add the enqueue hook itself.

**Phase 3 owns (does not exist yet on main):**
- `photo_jobs` table (Phase 2 was originally going to create it; reality: Phase 2 shipped a per-row `processing_state` instead). Phase 3 Task 2 creates the table from scratch.
- `enqueuePhotoJob` helper in `lib/jobs/enqueue.ts`.

**Phase 3 produces (consumed by Phase 4):**
- `face_detections` rows: `photo_id`, `bbox`, `embedding (vector(128))`, `cluster_id`, `confidence`, `landmarks_json`, `created_at`.
- `face_clusters` rows: per-event clusters with `representative_embedding (vector(128))`, `representative_detection_id`, `member_count`. `claimed_by_user_id` left NULL for Phase 4 to populate.
- `Photo.has_detected_faces` flipped to `true`/`false` exactly once.
- Worker HTTP contract: `POST /detect` (JSON), `POST /enroll` (stub returning 501 until Phase 4), `GET /health`, `GET /version`.
- `worker/config/thresholds.json` with locked production thresholds.
- Internal HMAC scheme (`WORKER_SECRET`) for Phase 4's `/enroll` calls to reuse.

---

## Tasks

### Task 1: Cold-start + CPU saturation measurement (milestone-0-style)

**Files:**
- Create: `docs/ops/worker-coldstart-2026-04.md`
- Create: `scripts/bench-worker-coldstart.sh` (read-only-ish: spawns containers, captures timings, no app code change)

**Step 1: Build the Phase 1 worker stub locally**
```bash
docker build -f worker/Dockerfile -t phostro-worker:stub .
```
Expected: image builds in <60s using the empty FastAPI stub from Phase 1 Task 1.

**Step 2: Time uvicorn cold start locally**
Script in `scripts/bench-worker-coldstart.sh`:
- runs `docker run --rm -p 8000:8000 phostro-worker:stub` 5 times
- measures wall time from `docker run` to first 200 response on `/health`
- records p50/p95

Expected output (stub only): p50 ~1.5s, p95 ~3s on Apple Silicon.

**Step 3: Build a "loaded" image with dummy ONNX model loading**
Add a temporary `worker/main.py` `@app.on_event("startup")` that loads `det_10g.onnx` and `face_recognition_sface_2021dec.onnx` from `/models` (mounted volume) but does no inference. Rebuild image.

Re-run cold-start script. Record numbers in `docs/ops/worker-coldstart-2026-04.md`.

**Step 4: Deploy stub to Fly.io trial and Railway trial**
- `fly launch --image phostro-worker:loaded` (no scale-to-zero) and (`auto_stop_machines=true`).
- `railway up` equivalent.
- Capture cold-start p50/p95 on both for: warm container, scaled-to-zero wakeup, fresh deploy.

**Step 5: Saturation test**
With one warm pod, hit `/health` plus a stub-detect endpoint (returns canned response after 200ms sleep) at concurrency 1, 2, 4, 8. Find the concurrency at which p95 latency knees up (CPU bound). This sets the default `WORKER_CONCURRENCY`.

**Expected output:** `docs/ops/worker-coldstart-2026-04.md` with a table per host:
| Host | Cold start (no models) | Cold start (models loaded) | Scale-from-zero wake | Knee concurrency | Decision |

**Verification:** Numbers checked in to git. Phase 1's deferred "worker hosting" decision is closed in this doc with a one-line "we picked X because Y."

**Failure visibility for this task:** Each container run logs to a per-run file in `/tmp/worker-coldstart/<timestamp>/`. The doc explicitly notes any runs that 500'd or timed out.

---

### Task 2: Schema — `photo_jobs` table + `failed_photo_jobs_recent` view

**Files:**
- Modify: `db/schema.ts`
- Generate: new migration in `db/migrations/`

**Note (revised 2026-05-01):** an earlier draft of this plan assumed Phase 2 would create `photo_jobs` as part of its upload-pipeline work. Phase 2 shipped a per-row `photos.processing_state` column instead (which tracks upload→preview only) and never added a job queue. Phase 3 owns this table from scratch.

**Step 1: Add the `photoJobs` Drizzle table**
- `id uuid pk default random`
- `photo_id uuid not null references photos(id) on delete cascade`
- `kind text not null default 'detect'` (Phase 6 may add `'preview'` or other kinds)
- `state text not null check in ('queued','claimed','succeeded','failed')` default `'queued'`
- `attempts int not null default 0`
- `max_attempts int not null default 5`
- `claimed_at timestamp` (nullable)
- `claimed_by text` (worker instance id; nullable)
- `last_error text` (nullable)
- `last_error_at timestamp` (nullable)
- `succeeded_at timestamp` (nullable)
- `failed_at timestamp` (nullable)
- `created_at timestamp not null default now()`
- `updated_at timestamp not null default now()`
- partial unique index on `(photo_id, kind) where state in ('queued','claimed','succeeded')` — at most one non-failed job per (photo, kind); resubmissions after failure are allowed.

**Step 2: Generate + apply migration**
```bash
pnpm db:generate && pnpm db:migrate
```

**Step 3: Add `failed_photo_jobs_recent` view via raw SQL migration**
```sql
CREATE OR REPLACE VIEW failed_photo_jobs_recent AS
SELECT pj.id, pj.photo_id, p.event_id, p.uploader_user_id,
       pj.attempts, pj.last_error, pj.last_error_at, pj.failed_at
FROM photo_jobs pj
JOIN photos p ON p.id = pj.photo_id
WHERE pj.state = 'failed' AND pj.failed_at > now() - interval '7 days'
ORDER BY pj.failed_at DESC;
```

**Verification:** `\d photo_jobs` in psql shows all columns and the partial unique index; `SELECT * FROM failed_photo_jobs_recent` returns empty.

**Failure visibility for this task:** the view itself is the visibility surface; that's the point.

**Step 4: Commit**
```bash
git add db/schema.ts db/migrations
git commit -m "feat(db): add photo_jobs queue table and failed_photo_jobs_recent view"
```

---

### Task 3: Schema — `face_detections` and `face_clusters`

**Files:**
- Modify: `db/schema.ts`
- Generate: migration

**Step 1: Add `faceDetections`**
- `id uuid pk default random`
- `photo_id uuid not null references photos(id) on delete cascade`
- `bbox_x1 real not null`, `bbox_y1`, `bbox_x2`, `bbox_y2` (image coords, see `bench/src/detect.py` `Face.bbox`)
- `confidence real not null`
- `landmarks_json jsonb not null` (5×2 array)
- `embedding vector(128) not null` (reuse the customType helper from Phase 1 Task 4)
- `cluster_id uuid` (nullable, FK to `face_clusters.id` on delete set null)
- `created_at timestamp not null default now()`
- ivfflat index on `embedding` with `vector_cosine_ops` (lists=100; revisit at scale).

**Step 2: Add `faceClusters`**
- `id uuid pk default random`
- `event_id uuid not null references events(id) on delete cascade`
- `representative_detection_id uuid` (nullable, FK to `face_detections.id` on delete set null — recomputed by clustering job)
- `representative_embedding vector(128) not null`
- `member_count int not null default 1`
- `claimed_by_user_id uuid` (nullable, FK; **left NULL by Phase 3** — Phase 4 sets this)
- `created_at`, `updated_at` timestamps.

**Step 3: Generate + apply migration**
```bash
pnpm db:generate && pnpm db:migrate
```

**Verification:** `pnpm db:studio` shows both tables; `\d face_detections` confirms `embedding` is `vector(128)`; `\di face_detections_*` confirms ivfflat index exists.

**Step 4: Commit**
```bash
git add db/schema.ts db/migrations
git commit -m "feat(db): add face_detections and face_clusters tables with pgvector index"
```

---

### Task 4: Photo job enqueue helper + wire into Phase 2's finalize route (TDD)

**Files:**
- Create: `lib/jobs/enqueue.ts`, `tests/jobs/enqueue.test.ts`
- Modify: `app/api/events/[id]/photos/[photoId]/finalize/route.ts` (add enqueue call after `processing_state='ready'` update)

**Step 1: Write failing test for `enqueuePhotoJob`**
- inserts a fake photo row
- calls `enqueuePhotoJob(photoId)`
- asserts a `photo_jobs` row exists with `state='queued'`, `kind='detect'`, `attempts=0`
- calling again is idempotent (returns existing row, does not raise unique violation against the partial index on `(photo_id, kind) where state in ('queued','claimed','succeeded')`)

**Step 2: Implement `enqueuePhotoJob(photoId, opts?)`** in `lib/jobs/enqueue.ts`
- defaults `kind='detect'`
- inserts with `onConflictDoNothing` on the partial unique index
- returns the row (existing or new)

**Step 3: Run, expect green.**

**Step 4: Wire into Phase 2's finalize route.** This is the integration point Phase 2 left open.

In `app/api/events/[id]/photos/[photoId]/finalize/route.ts`, immediately after the `db.update(photos).set({ processingState: 'ready', ... })` succeeds, call `await enqueuePhotoJob(photoId)`. Place it inside the same try block so a failure to enqueue surfaces an error to the client (the photo is still `ready`, but the upload UX should know the detection lane didn't start).

If the enqueue throws, log `worker.enqueue.failed` and let the route return 500. Phase 2's e2e test `host upload flow` will need a follow-up assertion: after finalize, a `photo_jobs` row exists with `kind='detect'`, `state='queued'`. Add that assertion in this task.

**Step 5: Failure visibility.** Caller logs `{event: 'photo_job.enqueued', photoId, jobId}` at info; idempotent re-enqueues log `{event: 'photo_job.enqueue.skipped', photoId, jobId}` so duplicate finalize calls aren't silently swallowed.

**Step 6: Commit**
```bash
git add lib/jobs tests/jobs app/api/events/\[id\]/photos/\[photoId\]/finalize
git commit -m "feat(jobs): enqueue detect job on photo finalize; idempotent helper"
```

---

### Task 5: Job claim helper — `SELECT … FOR UPDATE SKIP LOCKED` (TDD)

**Files:**
- Create: `lib/jobs/claim.ts`, `tests/jobs/claim.test.ts`

**Step 1: Write tests**
- `claimNextJob(workerId, claimTimeoutSec)` returns one job and stamps `state='claimed'`, `claimed_at`, `claimed_by`
- two concurrent claimers receive distinct jobs (use `Promise.all` with a small batch)
- a job whose `claimed_at` < `now() - claim_timeout` is reclaimable (watchdog)

**Step 2: Implement** using a single SQL statement:
```sql
UPDATE photo_jobs
SET state='claimed', attempts=attempts+1, claimed_at=now(), claimed_by=$1, updated_at=now()
WHERE id = (
  SELECT id FROM photo_jobs
  WHERE (state='queued')
     OR (state='claimed' AND claimed_at < now() - ($2 || ' seconds')::interval)
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

**Step 3: Run; expect green.**

**Failure visibility for this task:** every reclaim of a stuck job logs `worker.job.reclaimed` at warn level with the previous `claimed_by`. Operators can grep this to detect crash loops.

**Step 4: Commit**
```bash
git add lib/jobs tests/jobs
git commit -m "feat(jobs): add SKIP LOCKED claim helper with stuck-job reclaim"
```

---

### Task 6: Job completion + failure helpers (TDD)

**Files:**
- Create: `lib/jobs/complete.ts`, `tests/jobs/complete.test.ts`

**Step 1: Write tests**
- `markSucceeded(jobId)` → `state='succeeded'`, `succeeded_at` set
- `markFailed(jobId, errorString)` → if `attempts < max_attempts`, sets `state='queued'` and bumps `last_error`; else sets `state='failed'`, `failed_at`
- exponential backoff *deferred* — Phase 3 retries immediately; the watchdog claim timeout (Task 5) is the de-facto rate limit

**Step 2: Implement.**

**Step 3: Run; expect green.**

**Failure visibility for this task:** `markFailed` always emits `worker.job.failed` (final) or `worker.job.retry` structured logs with `attempts`, `last_error`, `photoId`, `eventId`. These are the primary operator signal.

**Step 4: Commit.**

---

### Task 7: Worker project — Python deps, recognition module, mirroring `bench/src/`

**Files:**
- Modify: `worker/requirements.txt`, `worker/Dockerfile`
- Create: `worker/recognition/__init__.py`, `worker/recognition/detect.py`, `worker/recognition/embed.py`, `worker/recognition/align.py`, `worker/recognition/providers.py`, `worker/config/thresholds.json` (placeholder), `worker/tests/test_recognition_smoke.py`, `worker/pyproject.toml`, `worker/.python-version`

**Step 1: Pin deps**
`worker/requirements.txt`:
```
fastapi>=0.111
uvicorn[standard]>=0.29
onnxruntime==1.17.3
numpy>=1.26,<2
opencv-python-headless>=4.9
scikit-image>=0.22
boto3>=1.34
psycopg[binary]>=3.1
httpx>=0.27
pydantic>=2.6
structlog>=24.1
sentry-sdk>=2.0
pytest>=8
pytest-asyncio>=0.23
```

**Step 2: Copy interfaces from `bench/src/`**
The plan is **not** to symlink — copy the three files (`detect.py`, `embed.py`, `align.py`) into `worker/recognition/` verbatim, change only the `MODEL_PATH` resolver to read from `os.environ['WORKER_MODELS_DIR']` (default `/models`). Same `Face` dataclass, same `Embedder.embed()` signature, same `align_face()`. This guarantees worker output is byte-identical to bench output and keeps the Phase 4 swap-out interface trivial.

`worker/recognition/providers.py` exposes the single point that Phase-4-or-later flips to `CoreMLExecutionProvider`/`CUDAExecutionProvider`.

**Step 3: thresholds.json (PLACEHOLDER — replaced in Task 11)**
```json
{
  "match_max_distance": 0.582,
  "maybe_max_distance": 0.6849,
  "_note": "PLACEHOLDER from synthetic-fixtures bench (45% hit rate). Replaced by labeled eval in Task 11.",
  "_source_report": "bench/reports/20260427T083650Z/report.md"
}
```

**Step 4: smoke test**
`worker/tests/test_recognition_smoke.py` uses one image from `bench/fixtures/group_shot/group_03.jpg` and asserts `len(faces) >= 2` and `embedding.shape == (128,)`.

**Step 5: Update Dockerfile**
- copy `worker/recognition/`, `worker/config/`, model files via build arg or volume mount (do **not** bake models into image yet — Task 12 decides).
- multi-stage build to keep final image small (`python:3.11-slim` for runtime, separate stage for `pip install`).
- non-root user.

**Step 6: pytest passes locally**
```bash
cd worker && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
WORKER_MODELS_DIR=../bench/models pytest tests/test_recognition_smoke.py
```

**Failure visibility for this task:** every detector or embedder import error fails fast at uvicorn startup (`@app.on_event("startup")`) with a `worker.startup.model_load_failed` structured log. The container won't pass its `/health` probe.

**Step 7: Commit**
```bash
git add worker
git commit -m "feat(worker): mirror bench detect/embed/align interfaces in worker package"
```

---

### Task 8: Worker `POST /detect` endpoint with R2 pull (TDD)

**Files:**
- Create: `worker/main.py` (replace stub), `worker/api/detect.py`, `worker/api/auth.py`, `worker/api/r2.py`, `worker/tests/test_detect_endpoint.py`, `worker/tests/test_auth.py`

**Step 1: HMAC auth dependency**
- `worker/api/auth.py` reads `WORKER_SECRET` env, verifies `X-Worker-Signature: sha256=<hex>` over the raw JSON body.
- `verify_signature(request, body)` raises 401 on mismatch.

**Step 2: Define request/response Pydantic models**
```
DetectRequest: photo_id (uuid), preview_get_url (str, presigned R2 GET), preview_sha256 (optional)
DetectResponse: photo_id, faces: list[FaceOut], elapsed_ms
FaceOut: bbox_x1..y2, confidence, landmarks (5x2), embedding (list[float] length 128)
```

**Step 3: Implement endpoint**
- `httpx.AsyncClient` GET on `preview_get_url` (timeout 15s)
- decode with `cv2.imdecode`
- run `Detector.detect()` then for each face `align_face()` → `Embedder.embed()`
- return JSON

**Step 4: Stub `/enroll` endpoint**
Returns 501 with a body `{"error":"not_implemented","phase":"4"}`. Locks the route name.

**Step 5: `/health` (already exists) and `/version`**
`/version` returns commit sha + model file hashes (sha256 of the two ONNX files at startup) + `WORKER_CONCURRENCY`.

**Step 6: pytest**
- `test_auth.py`: bad signature → 401, good signature → 200
- `test_detect_endpoint.py`: spin up an aiohttp/httpx-mocked server returning bytes from `bench/fixtures/group_shot/group_03.jpg`; call `/detect`; assert ≥2 faces and embedding length 128.

**Failure visibility for this task:** R2 fetch errors return HTTP 502 with body `{"error":"r2_fetch_failed","status":<n>}` and emit `worker.detect.r2_fetch_failed`. Image decode errors return 400 with `worker.detect.decode_failed`. Detector exceptions are 500 with full Sentry capture and `worker.detect.inference_failed`. Each error path is exercised by a unit test in this task.

**Step 7: Commit.**

---

### Task 9: Next.js worker client + dispatcher (TDD)

**Files:**
- Create: `lib/worker/client.ts`, `lib/worker/dispatcher.ts`, `tests/worker/client.test.ts`, `tests/worker/dispatcher.test.ts`

**Step 1: HTTP client**
`detectPhoto(photoId, previewKey)` in `lib/worker/client.ts`:
- mints a 5-minute presigned R2 GET URL via `createPresignedGetUrl(previewKey, 300)` imported from `@/lib/photos/r2` (Phase 2's R2 helper module)
- signs body with `WORKER_SECRET` (HMAC SHA-256)
- POSTs to `${WORKER_URL}/detect` with `X-Worker-Signature`
- 30s timeout, no internal retries (the queue retries)

**Step 2: Dispatcher**
`processOneJob(workerId)` in `lib/worker/dispatcher.ts`:
1. `claimNextJob(workerId, 120)` → null means idle
2. fetch the photo row + `r2_key_preview`. Defensive check: if `processing_state !== 'ready'` or `r2_key_preview` is null, mark the job failed with `error='photo_not_ready'` and return — this should not happen in practice because the enqueue happens after `ready`, but the dispatcher must be safe against races.
3. call `detectPhoto`
4. open a transaction:
   - insert `face_detections` rows
   - update `photos.has_detected_faces` (true if faces, false otherwise) — **never write `photos.processing_state`; that column is owned by Phase 2's upload pipeline**
   - `markSucceeded(jobId)`
5. on any throw: `markFailed(jobId, err.message)`

**Step 3: Tests**
- `client.test.ts`: mock fetch, assert HMAC header is correct, assert presigned URL used.
- `dispatcher.test.ts`: with a mocked client returning canned faces, assert DB rows + `has_detected_faces=true` + job state succeeded; with a client that throws, assert job retried up to `max_attempts` then `state='failed'`.

**Failure visibility for this task:** the dispatcher always logs one of: `worker.dispatch.success`, `worker.dispatch.retry`, `worker.dispatch.dead_letter`. Sentry breadcrumb on each. The dispatcher never swallows an error silently — every code path either succeeds or marks the job.

**Step 4: Commit.**

---

### Task 10: Dispatcher runner — long-poll loop and watchdog (TDD)

**Files:**
- Create: `scripts/run-dispatcher.ts`, `lib/worker/runner.ts`, `tests/worker/runner.test.ts`

**Step 1: Runner**
`runDispatcher({ concurrency, pollIntervalMs })`:
- spawns N concurrent `processOneJob` loops
- on idle (no job claimed) sleeps `pollIntervalMs` (default 2000ms)
- handles SIGTERM by finishing in-flight jobs and exiting cleanly within 30s

**Step 2: Watchdog**
A separate `setInterval(60_000)` calls a SQL helper that resets stuck `claimed` jobs older than 120s back to `queued` (the claim helper from Task 5 already handles this on next claim, but the explicit watchdog also emits a metric for visibility).

**Step 3: Wire to a CLI** — `pnpm tsx scripts/run-dispatcher.ts`. This runs **inside Next.js's Node runtime**, not inside the Python worker — the dispatcher is a TypeScript polling process that calls the Python worker over HTTP. Decision rationale: keeps DB code in one language; the Python worker stays a pure HTTP service.

**Step 4: Tests**
- runner with concurrency=2 processes 5 queued jobs in <2× single-job latency
- SIGTERM during processing finishes in-flight jobs

**Failure visibility for this task:** runner emits `worker.runner.started`, `worker.runner.shutting_down`, `worker.runner.idle` (debug) and `worker.watchdog.reclaimed N` (warn). Prometheus-style counters deferred; structured logs are sufficient for Phase 3.

**Step 5: Commit.**

---

### Task 11: Re-derive matching thresholds from labeled bench eval (BLOCKING for exit criterion 4)

**Files:**
- Create: `docs/ops/threshold-decision-2026-04.md`
- Modify: `worker/config/thresholds.json`

**Step 1: Assemble labeled fixture pack**
Per `bench/README.md` "Folder-per-identity fast path": collect **at minimum** 8 identities × 5 photos each (40 face crops). Use:
- 3-5 friends/team consenting members
- 3-5 public-domain face datasets per `bench/fixtures/labeled-template/`
Document provenance in `docs/ops/threshold-decision-2026-04.md` (consent matters; do not use scraped data).

**Step 2: Run init + eval**
```bash
phostro-bench init-labeled-manifest --dataset-dir bench/fixtures/wedding-face-crops
phostro-bench eval-labeled \
  --manifest bench/fixtures/wedding-face-crops/manifest.json \
  --out bench/reports --models bench/models \
  --target-precision 0.95
```

**Step 3: Read the labeled report**
Pull these numbers out of `labeled_report.md`:
- `match_max_distance` = best-F1 threshold OR target-precision threshold (pick the stricter; precision matters more than recall in beta because false positives are user-trust-destroying)
- `maybe_max_distance` = the threshold at recall floor (~0.85) — anything between match and maybe goes into the Phase 4 "maybe you?" bucket.

**Step 4: Lock thresholds**
Replace placeholders in `worker/config/thresholds.json` and remove the `_note` placeholder. Add `_source_report: "bench/reports/<run-id>/labeled_report.md"`, `_dataset_size`, `_eval_date`.

**Step 5: Document the decision**
`docs/ops/threshold-decision-2026-04.md` records: dataset description, sample sizes, ROC table snapshot, chosen thresholds, who approved, link to the labeled report.

**Verification:** Phase 3 exit criterion 4. CI grep-asserts `worker/config/thresholds.json` does **not** contain the string `PLACEHOLDER`.

**Failure visibility for this task:** if labeled hit rate is below 80% or best F1 < 0.85, **stop** and escalate before changing thresholds. The plan does not allow shipping a "we tried to make it work" threshold.

**Step 6: Commit**
```bash
git add worker/config/thresholds.json docs/ops/threshold-decision-2026-04.md
git commit -m "feat(worker): lock production matching thresholds from labeled bench eval"
```

---

### Task 12: Per-event clustering job (incremental cosine grouping)

**Files:**
- Create: `lib/worker/cluster.ts`, `scripts/run-cluster-job.ts`, `tests/worker/cluster.test.ts`

**Step 1: Algorithm**
For each event with detections that have `cluster_id IS NULL`:
1. Pull all clusters for that event with their `representative_embedding`.
2. For each unclustered detection, compute cosine distance to every cluster (small N at MVP scale).
3. If best distance < `match_max_distance` (read from `worker/config/thresholds.json` — also exposed via Next.js env): assign existing cluster, increment `member_count`, recompute representative as running mean.
4. Else: create a new `face_clusters` row with `representative_embedding = detection.embedding`, `representative_detection_id = detection.id`.

**Step 2: Schedule**
Run every 2 minutes during active phase. Phase 3 implements as a second polling script (`scripts/run-cluster-job.ts`); Phase 6 may move to a proper cron.

**Step 3: Tests**
- given 3 detections that are mutually similar, produce 1 cluster
- given 3 mutually dissimilar detections, produce 3 clusters
- detections from different events never share a cluster (event scope invariant)

**Failure visibility for this task:** every cluster job run emits `worker.cluster.run_completed` with counts: `events_processed`, `detections_clustered`, `clusters_created`, `elapsed_ms`. A run that throws emits `worker.cluster.failed` with full stack to Sentry; the script exits non-zero so a process supervisor (or cron) sees it.

**Step 4: Commit.**

---

### Task 13: docker-compose for local dev parity

**Files:**
- Create: `docker-compose.yml`, `worker/.dockerignore`, `Makefile` (or `justfile`)

**Step 1: compose file**
Services:
- `db`: `pgvector/pgvector:pg16`, env `POSTGRES_PASSWORD=pw`, port 5432, named volume.
- `worker`: build `./worker`, env `WORKER_SECRET`, `WORKER_MODELS_DIR=/models`, mounts `./bench/models:/models:ro` until Task 14 decides on baking models.
- `dispatcher`: same Node image as Next.js dev, runs `pnpm tsx scripts/run-dispatcher.ts`, depends on `db` and `worker`. Reads `DATABASE_URL`, `WORKER_URL=http://worker:8000`.
- `web`: Next.js dev server, port 3000, depends on `db`, `worker`.

**Step 2: Make targets**
```
make up        # docker-compose up --build
make down      # docker-compose down -v
make logs      # docker-compose logs -f worker dispatcher
make migrate   # docker-compose exec web pnpm db:migrate
make smoke     # runs an integration test that uploads a fixture jpg and waits for has_detected_faces
```

**Step 3: README update**
Add a "Local dev with worker" section linking to `make up`.

**Failure visibility for this task:** `make logs` is the operator's primary debug surface; structured logs from Tasks 5/6/9/10/12 stream there. `make smoke` exits non-zero and prints the full `failed_photo_jobs_recent` view if any job failed.

**Step 4: Commit.**

---

### Task 14: Model artifact strategy

**Files:**
- Create: `worker/models/.gitkeep`, `worker/scripts/download_models.sh`, `docs/ops/worker-models.md`
- Modify: `worker/Dockerfile`

**Step 1: Download script**
Mirror `bench/models/README.md` instructions; downloads `det_10g.onnx` and `face_recognition_sface_2021dec.onnx` to `worker/models/`. Verifies SHA-256.

**Step 2: Docker decision**
Bake models into the image (`COPY worker/models /models`) unless image size > 500MB makes deploys painful. Falls back to a startup-time S3/R2 download if too large. Decided based on Task 1 cold-start numbers: cold start with models baked vs. downloaded.

**Step 3: Document in `docs/ops/worker-models.md`** — sha256 hashes, source URLs, license attribution (MIT-safe builds per design doc).

**Failure visibility for this task:** SHA-256 mismatch on download → script exits non-zero. Startup-time download failure → `worker.startup.model_download_failed` structured log + container fails health check.

**Step 4: Commit.**

---

### Task 15: CI — Python worker tests + Docker build

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/worker-image.yml` (optional registry push)

**Step 1: Add a `worker` job to CI**
- runs on `ubuntu-latest`
- sets up Python 3.11
- installs `worker/requirements.txt`
- downloads bench models (cached by sha)
- runs `pytest worker/tests/`

**Step 2: Add an integration job**
- spins up `pgvector/pgvector:pg16` service
- builds the worker image
- runs `worker` and `dispatcher` as background services
- runs a Vitest integration test that registers a `photos` row, enqueues a job, waits up to 60s, asserts `face_detections` rows exist.

**Step 3: Threshold guard**
Add a step that fails if `worker/config/thresholds.json` contains `"_note"` matching the placeholder string from Task 7. This enforces exit criterion 4 at PR-time.

**Failure visibility for this task:** CI failure surfaces in PR checks. `failed_photo_jobs_recent` is logged on integration-test failure for postmortem.

**Step 4: Commit.**

---

### Task 16: Sentry / structured-log wiring

**Files:**
- Create: `lib/observability/logger.ts`, `worker/observability.py`
- Modify: `next.config.ts`, `worker/main.py`

**Step 1: Next.js side**
- structured logger (pino or `structured-log`) emitting JSON to stdout in production.
- Sentry SDK initialized only in production with `SENTRY_DSN`. Tags every event with `service=web|dispatcher`.

**Step 2: Worker side**
- `structlog` configured for JSON output.
- Sentry Python SDK; tag `service=worker`.

**Step 3: Audit every Phase-3 task for log coverage**
Cross-reference: every "Failure visibility" line above must correspond to a real `logger.warn`/`logger.error` call. CI grep test that the canonical event names (`worker.job.failed`, `worker.dispatch.dead_letter`, etc.) appear at least once in the codebase.

**Step 4: Commit.**

---

### Task 17: Documentation — runbook for operators

**Files:**
- Create: `docs/ops/photo-courier-worker-runbook.md`

**Sections:**
- "How do I see failed jobs?" → `SELECT * FROM failed_photo_jobs_recent`
- "How do I retry a single failed job?" → SQL update sets `state='queued', attempts=0`
- "How do I drain a stuck dispatcher?" → SIGTERM, watchdog handles in-flight
- "What does each log event mean?" → table mapping `worker.*` events to severity and recommended action
- "How do thresholds change?" → re-run Task 11; thresholds are not hot-tuned in production

**Step 1: Commit.**

---

### Task 18: Phase 3 end-to-end manual smoke

**Step 1**: deploy worker to chosen host (output of Task 1).
**Step 2**: spin up Next.js preview with `WORKER_URL` pointing at it.
**Step 3**: upload 10 real event photos via the Phase 2 UI.
**Step 4**: within 90 seconds, verify:
- `SELECT count(*) FROM face_detections WHERE photo_id IN (...)` > 0
- `SELECT has_detected_faces FROM photos` is fully populated (no NULLs)
- `SELECT * FROM failed_photo_jobs_recent` is empty
- Worker logs show one `worker.dispatch.success` per photo
- Cluster job has produced at least one `face_clusters` row per event
**Step 5**: deliberately upload a 0-byte JPEG; verify it lands in `state='failed'` after `max_attempts` and is visible in the SQL view and in Sentry.

**Step 6**: commit nothing — this task produces only confidence.

---

## Phase 3 review checkpoint

Before declaring Phase 3 done and moving on to Phase 4:

1. Run `superpowers:requesting-code-review` against the Phase 3 diff (Tasks 2–17).
2. Verify all 9 exit criteria with concrete evidence: links to commits, CI runs, the labeled bench report, the cold-start ops doc.
3. Re-read this plan's "Explicitly deferred" list and confirm none of it crept in.
4. Confirm thresholds in `worker/config/thresholds.json` are **not** the placeholders from `bench/reports/20260427T083650Z/report.md` (0.582 / 0.6849).
5. Confirm cold-start doc names a chosen host and that the worker is running there.
6. Resolve every Open Question in this plan in writing — close the doc with a "Decisions taken" appendix before opening the Phase 4 plan.
7. Spot-check `failed_photo_jobs_recent` and the operator runbook by having a non-author teammate try to debug a deliberately failed job using only the runbook.
8. Address Critical/Important review issues. Fix or explicitly defer with a tracking issue.
9. Only then write the Phase 4 plan.

---

## Cross-phase contracts (recap)

**Consumed from Phase 2:**
- `photos` table populated with `r2_key_original`, `r2_key_preview` (preview generation owned by Phase 2).
- `lib/r2/client.ts:presignGet(key, ttl)` available.
- A Phase 2 hook that calls `enqueuePhotoJob(photoId)` after upload registration.

**Produced for Phase 4:**
- `face_detections` rows with 128-d embeddings and event-scoped clusters.
- `face_clusters` rows with `claimed_by_user_id IS NULL` ready for enrollment to claim.
- Worker `POST /enroll` route reserved (returns 501 in Phase 3).
- HMAC scheme for Next.js → worker calls.
- Locked production thresholds in `worker/config/thresholds.json` for Phase 4 retrieval queries to read.
- Operator runbook for failed jobs that Phase 4's enrollment failures can also use.

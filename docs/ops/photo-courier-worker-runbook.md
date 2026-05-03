# Photo Courier Worker Runbook

Operational reference for the Phase 3 recognition pipeline: queue, dispatcher, Python worker, clustering job.

This runbook is for the on-call operator. If you're debugging a specific incident, jump to the section that matches your symptom. If you're learning the system, read top to bottom.

---

## System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Producer side (Next.js)                                             │
│                                                                      │
│  POST /api/events/:id/photos/:photoId/finalize                       │
│  └── enqueuePhotoJob()  ──────────►  photo_jobs (state=queued)       │
└──────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Dispatcher (Node — long-poll loop)                                  │
│                                                                      │
│  scripts/run-dispatcher.ts                                           │
│  ├─ claimNextJob()  ──── photo_jobs (state=claimed)                  │
│  ├─ detectPhoto() ──HMAC─►  Python worker  ──R2 GET──►  preview.jpg  │
│  ├─ tx { face_detections insert + photos.has_detected_faces flip     │
│  │       + markSucceeded() }                                         │
│  └─ on throw: markFailed() (retry or dead-letter)                    │
│                                                                      │
│  Watchdog: every 60s, reset jobs claimed > 120s ago                  │
└──────────────────────────────────────────────────────────────────────┘
                                            │
                                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Cluster job (Node — periodic polling)                               │
│                                                                      │
│  scripts/run-cluster-job.ts                                          │
│  └─ for each event: assign cluster_id to unclustered detections      │
│     using cosine distance ≤ MATCH_MAX_DISTANCE (env, default 0.528)  │
└──────────────────────────────────────────────────────────────────────┘
```

State diagram for a single `photo_jobs` row:

```
  queued ──claim──► claimed ──success──► succeeded
    ▲                  │
    │                  └──fail (attempts<max)──► queued
    │                  └──fail (attempts≥max)──► failed
    │
    └── watchdog (claimed_at < now() - 120s)
```

---

## Quick reference

| Question | Answer |
|---|---|
| Are we processing photos? | `SELECT count(*) FROM photo_jobs WHERE state='queued'` should be small (<100) and not growing |
| Anything failing right now? | `SELECT * FROM failed_photo_jobs_recent LIMIT 20` |
| Is the worker responding? | `curl https://<worker-host>/health` returns 200 |
| Is the dispatcher running? | Check process supervisor; logs should show `worker.runner.idle` or `worker.dispatch.success` events |
| Where do I find the thresholds? | `worker/config/thresholds.json` (current version locked 2026-05-03 from labeled bench eval) |

---

## Section 1 — How do I see failed jobs?

The `failed_photo_jobs_recent` SQL view surfaces every job in `state='failed'` from the last 7 days. This is your primary triage surface — operators should not need to read `photo_jobs` directly for routine work.

```sql
SELECT id, photo_id, event_id, uploader_user_id,
       attempts, last_error, last_error_at, failed_at
FROM failed_photo_jobs_recent
ORDER BY failed_at DESC
LIMIT 50;
```

Returns:
- `id` — the job UUID
- `photo_id` — the photo that wasn't processed
- `event_id` — which event the photo belongs to (helps you see if failures cluster by event)
- `uploader_user_id` — who uploaded the photo
- `attempts` — how many tries before dead-letter (will equal `max_attempts`, default 5)
- `last_error` — the error message captured by `markFailed()`. Prefixed with the worker's structured event name when it came from the worker (e.g., `worker.detect.r2_fetch_failed`)
- `last_error_at` — when the last failure happened
- `failed_at` — when the dead-letter transition happened

**Filter by event:**
```sql
SELECT * FROM failed_photo_jobs_recent
WHERE event_id = '<event-uuid>'
ORDER BY failed_at DESC;
```

**Filter by error class:**
```sql
SELECT last_error, count(*) FROM failed_photo_jobs_recent
GROUP BY last_error
ORDER BY count(*) DESC;
```

If a single error message dominates (e.g., 80% are `worker.detect.r2_fetch_failed`), check the worker's R2 credentials or upstream R2 status before retrying anything.

---

## Section 2 — How do I retry a single failed job?

**Manual retry** (use sparingly — usually you want to fix the root cause first):

```sql
UPDATE photo_jobs
SET state = 'queued',
    claimed_at = NULL,
    claimed_by = NULL,
    attempts = 0,
    last_error = NULL,
    last_error_at = NULL,
    failed_at = NULL,
    updated_at = now()
WHERE id = '<job-uuid>';
```

The dispatcher will pick it up on its next poll. Watch the result:

```sql
SELECT state, attempts, last_error, succeeded_at, failed_at
FROM photo_jobs
WHERE id = '<job-uuid>';
```

**Bulk retry** (e.g., after fixing a transient upstream issue that produced a wave of failures):

```sql
-- Reset all jobs failed in the last hour with a specific error
UPDATE photo_jobs
SET state='queued', claimed_at=NULL, claimed_by=NULL,
    attempts=0, last_error=NULL, last_error_at=NULL,
    failed_at=NULL, updated_at=now()
WHERE state = 'failed'
  AND failed_at > now() - interval '1 hour'
  AND last_error LIKE '%r2_fetch_failed%';
```

**Why we manually reset `attempts=0`:** the partial unique index on `(photo_id, kind) WHERE state IN ('queued','claimed','succeeded')` allows a fresh queued row to coexist with a failed row, but resetting in place is cheaper than inserting a new one. Resetting `attempts` gives the job its full retry budget back.

**Why this is rarely needed:** the dispatcher has built-in retry logic (`markFailed` re-queues until `attempts >= max_attempts`). Manual retry is for cases where the failure was caused by something outside the system (R2 outage, network partition) and you want to recover after the upstream is healthy.

---

## Section 3 — How do I drain a stuck dispatcher?

The dispatcher process is a long-poll loop with N concurrent workers per `WORKER_DISPATCHER_CONCURRENCY` (default 2).

**Graceful shutdown:**
```
kill -TERM <pid>       # or SIGINT (Ctrl+C)
```

The dispatcher's SIGTERM handler:
1. Sets `shuttingDown=true`
2. Wakes any sleeping poll loops
3. Allows in-flight `processOneJob` calls to finish naturally (their HTTP call to the Python worker completes; their DB transaction commits or rolls back independently)
4. `joined` resolves when all loops have exited
5. Process exits 0

In testing, in-flight jobs finish in well under 1s; the budget is 30s. If the dispatcher hangs past 30s waiting for shutdown, escalate.

**Stuck-job recovery is automatic:**
- The watchdog runs every 60s. It looks for jobs in `state='claimed'` with `claimed_at < now() - 120s` and resets them to `queued`.
- The watchdog also emits a `worker.watchdog.reclaimed` warn log with the previous `claimed_by` worker ID.
- A SIGKILL'd dispatcher leaves jobs in `claimed` state; the watchdog cleans them up within 60-120s.

**If the watchdog itself is broken**, manually reset claimed jobs:

```sql
UPDATE photo_jobs
SET state='queued', claimed_at=NULL, claimed_by=NULL, updated_at=now()
WHERE state='claimed'
  AND claimed_at < now() - interval '5 minutes';
```

---

## Section 4 — Log event reference

Every Phase 3 component emits structured JSON logs of the form `{ event: "...", ...fields }`. Grep by `event` value.

### Producer side (Next.js)

| Event | Severity | Source | Action |
|---|---|---|---|
| `photo_job.enqueue` | info | `lib/jobs/enqueue.ts` | None — successful enqueue. Includes `jobId`, `state`. Repeated `jobId` across calls = idempotent re-enqueue. |
| `worker.enqueue.failed` | error | finalize route | Investigate — finalize succeeded but couldn't write the job row. Check DB connectivity. Photo is `ready` but won't get processed until manual enqueue or re-finalize. |

### Dispatcher (Node)

| Event | Severity | Source | Action |
|---|---|---|---|
| `worker.runner.started` | info | `lib/worker/runner.ts` | None — startup signal |
| `worker.runner.idle` | debug | runner | None — no jobs to process. First idle log after activity, not every poll. |
| `worker.runner.shutting_down` | info | runner | None — clean SIGTERM in progress |
| `worker.runner.unhandled_error` | error | runner | Investigate — `processOneJob` shouldn't throw (it always handles errors via markFailed). If you see this, a code path is leaking exceptions. |
| `worker.runner.uncaught_exception` / `worker.runner.unhandled_rejection` | error | runner CLI | Process crashed — check stack trace; the runner exited 1. |
| `worker.dispatch.success` | info | dispatcher | None — happy path. Includes `jobId`, `photoId`, faces count. |
| `worker.dispatch.retry` | info | dispatcher | None — job failed but will retry. Includes attempt count and error. |
| `worker.dispatch.dead_letter` | error | dispatcher | Investigate — job exhausted retries. Now visible in `failed_photo_jobs_recent`. |
| `worker.dispatch.race_loss` | warn | dispatcher | Rare — job was reclaimed by another worker mid-processing; transaction rolled back cleanly. No action unless you see a flood (would suggest watchdog timeout is too short). |
| `worker.dispatch.photo_not_ready` | warn | dispatcher | Investigate — defensive check fired. Photo wasn't in `processing_state='ready'` when dispatcher tried to process it. Should not happen in practice (Phase 2 sets ready before enqueue). If recurring, check the finalize route's enqueue ordering. |
| `worker.dispatch.mark_failed_late` | warn | dispatcher | Rare — dispatcher tried to fail a job that was no longer claimed (e.g., a watchdog reclaim won the race). The original error is preserved in the log. |
| `worker.job.reclaimed` | warn | claim helper | A stuck `claimed` job was reclaimed. Includes `previousClaimedBy` (which worker died). Single occurrences are fine; sustained = a worker is crashing repeatedly. |
| `worker.job.failed` | error | markFailed | Dead-letter transition. Same row as `worker.dispatch.dead_letter` — duplicate by design (the helpers and dispatcher both log). |
| `worker.job.retry` | info | markFailed | Retry transition (state went queued → claimed → queued again). |
| `worker.job.late_marker` | warn | markFailed | A late `markFailed` call hit a job no longer in `claimed` state. Original error preserved. |
| `worker.job.notfound` | warn | markFailed | Stale job ID. Almost always a bug — investigate where the call came from. |
| `worker.watchdog.reclaimed` | warn | runner | Stuck jobs were reset. Includes `n` (count) and `jobs[].previousClaimedBy`. Repeated `previousClaimedBy` for the same worker = crash loop. |
| `worker.watchdog.error` | error | runner | Watchdog SQL itself failed. Investigate DB connectivity. |

### Cluster job (Node)

| Event | Severity | Source | Action |
|---|---|---|---|
| `worker.cluster.run_completed` | info | `lib/worker/cluster.ts` | None — successful run. Includes `eventsProcessed`, `detectionsClustered`, `clustersCreated`, `elapsedMs`. |
| `worker.cluster.failed` | error | cluster.ts | Investigate — a single event's clustering threw. Other events still complete (per-event transactions). |
| `worker.cluster.shutting_down` | info | run-cluster-job | Clean SIGTERM |
| `worker.cluster.fatal` | error | run-cluster-job | Process crashed — the loop exited non-zero. |
| `worker.cluster.bad_env` | error | run-cluster-job | Bad env config (e.g., MATCH_MAX_DISTANCE not parseable). Process exits without running. |

### Python worker

| Event | Severity | Source | Action |
|---|---|---|---|
| `worker.startup.model_load_failed` | fatal | worker/main.py | Container won't start. Check that ONNX models are present at `WORKER_MODELS_DIR`. |
| `worker.startup.missing_secret` | fatal | worker/main.py | `WORKER_SECRET` env var unset or empty. Container won't start. |
| `worker.detect.r2_fetch_failed` | error | worker/api/r2.py | R2 GET failed. Returns 502 with upstream status. Includes connection error or non-2xx upstream response code. |
| `worker.detect.decode_failed` | error | worker/api/detect.py | `cv2.imdecode` returned None — bytes weren't a valid image. Returns 400. |
| `worker.detect.inference_failed` | error | worker/api/detect.py | Detector or embedder threw. Returns 500. Sentry captures full stack (when DSN configured). |

---

## Section 5 — How do thresholds change?

**Production thresholds live in `worker/config/thresholds.json`** (NOT in env vars at this time, contrary to some early plan drafts). The file is read once at clustering job startup (via env var `MATCH_MAX_DISTANCE` if set, otherwise the JSON default).

Current locked values (2026-05-03):
- `match_max_distance: 0.528`
- `maybe_max_distance: 0.595`

See `docs/ops/threshold-decision-2026-04.md` for the full eval rationale.

### Do NOT hot-tune in production

Tempting moves that you should NOT make:
- Edit the JSON file directly on a deployed host
- Set `MATCH_MAX_DISTANCE` to a different value than the JSON for "just one experiment"

Reasons:
1. Thresholds are tuned against a specific labeled dataset. A casual change breaks the ROC analysis the doc cites.
2. The CI threshold guard (Task 15) verifies the JSON doesn't contain the literal string `PLACEHOLDER`. It does NOT verify the values are sane.
3. Production matches are persisted in `face_detections.cluster_id` AND `face_clusters.member_count` — changing the threshold mid-flight produces inconsistent clusters where the boundary depends on when the detection was processed.

### To actually change thresholds

1. Gather a new labeled dataset (or augment the existing one). Phase 4 should add real beta-collected pairs.
2. Run `phostro-bench eval-labeled` against the new dataset.
3. Update `worker/config/thresholds.json` with the new values + a fresh `_source_report` link + `_eval_date`.
4. Update `docs/ops/threshold-decision-2026-04.md` (or create a new dated decision doc) explaining the change.
5. Re-cluster: existing `face_detections.cluster_id` assignments are stale. Either:
   - Run a one-time job that nulls all `cluster_id` and `face_clusters` rows, then lets the cluster job rebuild
   - Or accept the inconsistency (new detections get new boundary, old detections keep their old assignment)
   The first is correct but invalidates Phase 4 user→cluster mappings; coordinate with the user-facing surface before doing it.
6. Deploy.
7. Watch `worker.cluster.run_completed` logs — confirm `clustersCreated` returns to a steady state within a few cycles.

### Phase 4 retuning trigger

Per `docs/ops/threshold-decision-2026-04.md`: if recall drops below 0.7 in the first 100 beta users (measured by user-reported "I'm in this photo but it didn't show up"), retune. Don't retune for cosmetic precision concerns until you have ≥1000 real production pairs to evaluate against.

---

## Section 6 — Common diagnostic queries

**Queue depth** (should be small, <100, not growing):
```sql
SELECT state, count(*) FROM photo_jobs GROUP BY state;
```

**Recent throughput** (jobs succeeded per hour):
```sql
SELECT date_trunc('hour', succeeded_at) AS hour, count(*)
FROM photo_jobs
WHERE state='succeeded' AND succeeded_at > now() - interval '24 hours'
GROUP BY hour ORDER BY hour DESC;
```

**Slow jobs** (claimed > 60s ago and still claimed — about to be reclaimed):
```sql
SELECT id, photo_id, claimed_by, claimed_at, attempts
FROM photo_jobs
WHERE state='claimed' AND claimed_at < now() - interval '60 seconds';
```

**Jobs by uploader** (find the user generating churn):
```sql
SELECT uploader_user_id, count(*) FROM failed_photo_jobs_recent
GROUP BY uploader_user_id ORDER BY count(*) DESC LIMIT 10;
```

**Investigate a specific photo**:
```sql
-- The job
SELECT * FROM photo_jobs WHERE photo_id = '<photo-uuid>';

-- The detections (if any)
SELECT id, bbox_x1, bbox_y1, confidence, cluster_id
FROM face_detections WHERE photo_id = '<photo-uuid>';

-- The photo's metadata
SELECT processing_state, has_detected_faces, r2_key_preview, uploaded_at
FROM photos WHERE id = '<photo-uuid>';
```

**Cluster summary for an event**:
```sql
SELECT fc.id, fc.member_count, fc.created_at,
       count(fd.id) AS actual_member_count
FROM face_clusters fc
LEFT JOIN face_detections fd ON fd.cluster_id = fc.id
WHERE fc.event_id = '<event-uuid>'
GROUP BY fc.id;
```

`member_count` and `actual_member_count` should match. Drift = a clustering bug; investigate.

---

## Section 7 — Escalation

| Symptom | Escalate to |
|---|---|
| `failed_photo_jobs_recent` shows >10% of recent jobs failing | Owner of the failing component (R2 → infra; ONNX → ML; auth → backend) |
| Watchdog firing in a loop on the same `claimed_by` | The dispatcher process is crashing — check stack traces, restart with verbose logging |
| Cluster `member_count` drifts from actual count | Phase 3 cluster job has a bug — open an issue, capture the SQL state |
| Threshold values seem wrong (high recall, low precision OR vice versa) | Re-run `phostro-bench eval-labeled`; if numbers shifted, see Section 5 |
| Worker `/health` returns 200 but `/detect` always 500s | Likely model file corruption or version mismatch. Restart container; if recurring, redownload models via `worker/scripts/download_models.sh`. |
| Sentry events flooded with `worker.detect.inference_failed` | One bad input image is reaching the worker repeatedly. Check `failed_photo_jobs_recent` for repeated `photo_id`. |

---

## Section 8 — Useful CLI commands

**Local dev stack:**
```
make up        # docker compose up --build
make logs      # tail worker + dispatcher
make down      # full teardown including DB volumes
make stop      # halt without nuking volumes
make smoke     # health-check + failed view query
make migrate   # run pending DB migrations
```

**Manual dispatcher run** (outside compose, e.g., during incident debugging):
```
WORKER_ID=op-rescue-1 \
  WORKER_DISPATCHER_CONCURRENCY=1 \
  pnpm tsx scripts/run-dispatcher.ts
```

**Manual cluster job run:**
```
pnpm tsx scripts/run-cluster-job.ts
```

**Re-run threshold eval:**
```
PYTHONPATH=$(pwd) bench/.venv/bin/python -m bench.src.bench eval-labeled \
  --manifest bench/fixtures/wedding-face-crops/manifest.json \
  --out bench/reports \
  --models bench/models \
  --target-precision 0.95
```

---

## Reference

- Architecture overview: `docs/plans/2026-04-27-photo-courier-phase-3.md`
- Threshold decision: `docs/ops/threshold-decision-2026-04.md`
- Cold-start measurements: `docs/ops/worker-coldstart-2026-04.md`
- Model artifact strategy: `docs/ops/worker-models.md`

# Face Scan v1 — Deploy Runbook

Operational runbook for the migration that ships multi-angle face scan enrollment + ArcFace R50 (512-d) recognition. Migration file: `db/migrations/0008_face_scan_v1_autogen.sql`. Design: `docs/plans/2026-05-07-face-scan-enrollment-design.md`.

**This is a destructive migration.** All `face_detections` rows are wiped, `face_clusters` are wiped, `users.face_embedding` is NULLed for all users. There is no rollback — restore from a DB backup if needed.

## Pre-flight

- DB backup taken in the last hour (Phase-4 backup story will formalize this; manually `pg_dump` or take a managed-DB snapshot).
- New worker image built with ArcFace R50 onboard. Verify locally: `WORKER_MODELS_DIR=$(pwd)/worker/models WORKER_SECRET=test worker/.venv/bin/python -m pytest worker/tests/` returns 39 passed.
- New Vercel deployment built and promoted to a preview URL (NOT production yet).
- `MATCH_MAX_DISTANCE` updated on Fly + Vercel to the new ArcFace value (see `docs/ops/threshold-decision-2026-05.md` — must be unset from `_status: PLACEHOLDER` first by running the bench + dogfood acceptance steps).

## Sequence

The order matters because:

- Vercel-first deploy: new app code expects 512-d, old worker still emits 128-d → every contributor upload tries to insert 128-d into `vector(512)` → fails.
- Worker-first deploy without app deploy: new worker emits 512-d, old app code accepts it (Drizzle `vector` toDriver is dim-agnostic). Tolerable but stale `users.face_embedding`-based enrollment checks still active.
- Migration-then-worker-then-app is the only safe order.

```
1.  fly scale count 0 -a phostro-worker
2.  Wait for photo_jobs.state='claimed' to drop to 0:
        psql $DATABASE_URL -c "SELECT count(*) FROM photo_jobs WHERE state='claimed';"
    Expect: 0. If any remain after 60s, investigate before continuing —
    they will be force-failed by the migration but indicate a stuck worker.
3.  Run the migration:
        DATABASE_URL=... npx drizzle-kit migrate
    Watch the NOTICE output. If `migration_face_scan_v1_reset` shows any
    affected rows, the drain in step 2 was incomplete — note this and
    review afterwards.
4.  Deploy worker image: fly deploy -a phostro-worker
5.  Verify worker health: curl https://phostro-worker.fly.dev/health
6.  Verify worker version reports w600k_r50.onnx in model_hashes:
        curl https://phostro-worker.fly.dev/version | jq .model_hashes
7.  Deploy Vercel app: vercel deploy --prod
8.  fly scale count 1 -a phostro-worker
9.  Smoke test: founder re-enrolls via /me/face/enroll, verifies 3 angles
    captured, then uploads a known photo to a test pocket and confirms
    it appears in the You-feed.
```

## Post-deploy verification

- Tail Fly worker logs for `worker.detect.inference_failed` events — should be zero.
- Tail Vercel logs for `face.enroll.angle.*` — should see `success` events from the founder's re-enrollment.
- Check `face_detections` row count is climbing as the re-detect backlog drains: `SELECT count(*) FROM face_detections;`
- After 30 minutes: `ANALYZE face_detections;` so the IVFFlat planner has fresh stats (the index was recreated empty).
- Pull yaw scores from the founder's enrollment for empirical threshold tuning:
    ```sql
    SELECT angle, yaw, quality_score, enrolled_at
      FROM user_face_embeddings
     WHERE user_id = '<founder-id>'
     ORDER BY enrolled_at DESC LIMIT 6;
    ```
  If `yaw` magnitudes for `left`/`right` are < 0.18 the gate's `YAW_TURN_MIN` constant in `lib/auth/face-enrollment.ts` should be lowered.

## Failure recovery

- **Migration fails partway**: rollback transactions; restore from backup; investigate.
- **Worker boots but model load fails**: rollback worker, ensure `w600k_r50.onnx` is on the volume (`fly ssh console -a phostro-worker -C "ls -lh /models"`). If missing, the build artifact didn't include it — fix the Dockerfile/script.
- **App deploy errors**: rollback Vercel deployment; the worker is forward-compatible (returns 512-d, old app inserted via Drizzle's dim-agnostic vector type).
- **Coldstart > 5s on Fly**: see `docs/ops/worker-coldstart-2026-04.md`. Either disable scale-from-zero (always-on) or lazy-load the recognition model on first `/detect`.

## Reference

- Migration: `db/migrations/0008_face_scan_v1_autogen.sql`
- Threshold decision: `docs/ops/threshold-decision-2026-05.md`
- Design: `docs/plans/2026-05-07-face-scan-enrollment-design.md`
- Cold-start baseline: `docs/ops/worker-coldstart-2026-04.md`

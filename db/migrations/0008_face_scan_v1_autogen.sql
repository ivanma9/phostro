-- 0008 — Face scan v1: multi-angle enrollment + ArcFace R50 (512-d).
--
-- Hand-written; supersedes drizzle-kit's auto-generated SET DATA TYPE which
-- can't safely change pgvector dimensions on a populated column.
--
-- Destructive migration:
--   * face_detections.embedding is dropped (no way to remap 128-d SFace → 512-d ArcFace)
--   * face_clusters are wiped (representative embeddings now invalid)
--   * users.face_embedding is NULLed (forces re-enrollment via the new flow)
-- All face data is re-derived by re-queueing detect jobs against the same photos.
--
-- DEPLOY SEQUENCE (must follow before running this migration):
--   1. fly scale count 0 -a phostro-worker  (drain in-flight workers)
--   2. Wait for photo_jobs.state='claimed' to drain (or stale-claim threshold)
--   3. Run THIS migration
--   4. Deploy new worker image (ArcFace R50 + 512-d FaceOut + yaw)
--   5. Deploy Vercel app (new schema reader + 512-d API + face-scan UI)
--   6. fly scale count 1 -a phostro-worker
--
-- Rollback: forward-only. Restore from DB backup if needed. No production users
-- exist at the time of cutover; founder will re-enroll.

-- Reset orphaned in-flight jobs that were claimed by a now-stopped worker.
-- They held an active row in the unique partial index, so re-enqueue would
-- conflict otherwise. Mark failed; the partial index excludes 'failed' state.
--
-- A non-zero row count below means the deploy runbook's "drain workers" step
-- was incomplete — the affected jobs may have written 128-d embeddings into
-- the old vector(128) column just before the column was replaced. The
-- migration still completes (those detections are about to be wiped anyway),
-- but operators should investigate why workers were not drained. See
-- docs/ops/face-scan-deploy.md.
DO $$
DECLARE
  reset_count integer;
BEGIN
  UPDATE "photo_jobs"
     SET state = 'failed',
         last_error = 'migration_face_scan_v1_reset',
         failed_at = now(),
         updated_at = now()
   WHERE state = 'claimed';
  GET DIAGNOSTICS reset_count = ROW_COUNT;
  IF reset_count > 0 THEN
    RAISE NOTICE 'face_scan_v1: force-failed % stale claimed jobs (drain incomplete?)', reset_count;
  END IF;
END $$;
--> statement-breakpoint

-- Drop the IVFFlat index (it's bound to the column's vector dim).
DROP INDEX IF EXISTS "face_detections_embedding_idx";
--> statement-breakpoint

-- Wipe face_detections + face_clusters. CASCADE handles the circular FK pair.
TRUNCATE TABLE "face_detections", "face_clusters" CASCADE;
--> statement-breakpoint

-- Recreate vector columns at the new 512-d dimension.
ALTER TABLE "face_detections"
  DROP COLUMN "embedding",
  ADD COLUMN "embedding" vector(512) NOT NULL;
--> statement-breakpoint

ALTER TABLE "face_clusters"
  DROP COLUMN "representative_embedding",
  ADD COLUMN "representative_embedding" vector(512) NOT NULL;
--> statement-breakpoint

-- Recreate IVFFlat index. lists=100 unchanged from pre-migration tuning;
-- planner will prefer seq scan until the table refills enough for the index
-- to be selective. ANALYZE after the re-detect backlog clears.
CREATE INDEX "face_detections_embedding_idx" ON "face_detections"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
--> statement-breakpoint

-- New per-angle enrollment table. Source of truth for face matching post-cutover.
CREATE TABLE "user_face_embeddings" (
  "user_id" uuid NOT NULL,
  "angle" text NOT NULL,
  "embedding" vector(512) NOT NULL,
  "quality_score" integer NOT NULL,
  "yaw" real NOT NULL,
  "preview_r2_key" text NOT NULL,
  "enrolled_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "user_face_embeddings_user_id_angle_pk" PRIMARY KEY ("user_id", "angle"),
  CONSTRAINT "user_face_embeddings_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
  CONSTRAINT "user_face_embeddings_angle_check"
    CHECK ("angle" IN ('frontal', 'left', 'right'))
);
--> statement-breakpoint

CREATE INDEX "user_face_embeddings_user_id_idx" ON "user_face_embeddings" ("user_id");
--> statement-breakpoint

-- Force re-enrollment of all existing users. Legacy single-selfie embedding
-- is unusable against the 512-d ArcFace cluster representatives.
UPDATE "users"
   SET face_embedding = NULL,
       face_quality_score = NULL,
       face_enrolled_at = NULL
 WHERE face_embedding IS NOT NULL
    OR face_quality_score IS NOT NULL
    OR face_enrolled_at IS NOT NULL;
--> statement-breakpoint

-- Re-queue 'detect' jobs for every photo whose pipeline previously succeeded
-- or was mid-flight. The partial unique index on (photo_id, kind, active states)
-- prevents duplicate active rows; ON CONFLICT DO NOTHING is a defense-in-depth
-- guard for re-runs.
INSERT INTO "photo_jobs" (photo_id, kind, state)
SELECT id, 'detect', 'queued'
  FROM "photos"
 WHERE processing_state IN ('ready', 'processing')
   AND deleted_at IS NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Photos that were 'processing' had their face_detections wiped. Reset them
-- to 'pending' so the upload pipeline reprocesses cleanly.
UPDATE "photos"
   SET processing_state = 'pending',
       processing_claimed_at = NULL
 WHERE processing_state = 'processing';

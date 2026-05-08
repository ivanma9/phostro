-- 0008 — Face scan v1: multi-angle enrollment + ArcFace R50 (512-d).
--
-- ADDITIVE MIGRATION (Option C). v1 face_detections / face_clusters are NOT
-- touched. New 512-d ArcFace pipeline writes to *_v2 shadow tables alongside.
-- Rollback path: revert app + worker code; v1 tables remain populated and the
-- old (pre-face-scan) code path keeps reading them. After ≥1 week of clean v2
-- operation, drop v1 tables in a follow-up migration.
--
-- This migration does NOT (intentionally):
--   - DROP, TRUNCATE, or alter v1 face_detections / face_clusters
--   - NULL out users.face_embedding (preserves prior enrollments for rollback)
--   - Change processing_state on any photo
-- The only mutating writes are at the bottom: re-queue 'detect' jobs against
-- all ready/processing photos so the new worker (which writes to *_v2) can
-- populate the new tables. Old 'detect' rows in 'succeeded' state are deleted
-- to free the partial unique index slot — that's bookkeeping data, not face
-- detection data.
--
-- DEPLOY SEQUENCE (less destructive than the prior plan, still required):
--   1. fly scale count 0 -a phostro-worker  (drain in-flight workers)
--   2. Wait for photo_jobs.state='claimed' to drop to 0
--   3. Run THIS migration
--   4. Deploy new worker image (ArcFace R50, writes to face_detections_v2)
--   5. Deploy Vercel app (reads face_detections_v2 / face_clusters_v2)
--   6. fly scale count 1 -a phostro-worker
-- See docs/ops/face-scan-deploy.md.

CREATE TABLE "face_clusters_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"representative_detection_id" uuid,
	"representative_embedding" vector(512) NOT NULL,
	"member_count" integer DEFAULT 1 NOT NULL,
	"claimed_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "face_detections_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"bbox_x1" real NOT NULL,
	"bbox_y1" real NOT NULL,
	"bbox_x2" real NOT NULL,
	"bbox_y2" real NOT NULL,
	"confidence" real NOT NULL,
	"landmarks_json" jsonb NOT NULL,
	"embedding" vector(512) NOT NULL,
	"yaw" real NOT NULL,
	"cluster_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_face_embeddings" (
	"user_id" uuid NOT NULL,
	"angle" text NOT NULL,
	"embedding" vector(512) NOT NULL,
	"quality_score" integer NOT NULL,
	"yaw" real NOT NULL,
	"preview_r2_key" text NOT NULL,
	"enrolled_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_face_embeddings_user_id_angle_pk" PRIMARY KEY("user_id","angle"),
	CONSTRAINT "user_face_embeddings_angle_check" CHECK (angle IN ('frontal','left','right'))
);
--> statement-breakpoint
ALTER TABLE "face_clusters_v2" ADD CONSTRAINT "face_clusters_v2_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_clusters_v2" ADD CONSTRAINT "face_clusters_v2_representative_detection_id_face_detections_v2_id_fk" FOREIGN KEY ("representative_detection_id") REFERENCES "public"."face_detections_v2"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_clusters_v2" ADD CONSTRAINT "face_clusters_v2_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_detections_v2" ADD CONSTRAINT "face_detections_v2_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_detections_v2" ADD CONSTRAINT "face_detections_v2_cluster_id_face_clusters_v2_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."face_clusters_v2"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_face_embeddings" ADD CONSTRAINT "user_face_embeddings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "face_clusters_v2_event_id_idx" ON "face_clusters_v2" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "face_detections_v2_photo_id_idx" ON "face_detections_v2" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "face_detections_v2_embedding_idx" ON "face_detections_v2" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists=100);--> statement-breakpoint
CREATE INDEX "user_face_embeddings_user_id_idx" ON "user_face_embeddings" USING btree ("user_id");--> statement-breakpoint

-- Re-queue detect jobs so the new worker populates face_detections_v2 for
-- every existing photo. Two-step: (1) free the partial unique index slot held
-- by prior 'succeeded' detect jobs; (2) reset stale 'claimed' jobs (defense
-- in depth — operator should have drained workers per runbook); (3) insert
-- the new queued rows. ON CONFLICT DO NOTHING is a safety net for re-runs.
DELETE FROM "photo_jobs"
 WHERE kind = 'detect' AND state = 'succeeded';--> statement-breakpoint

DO $$
DECLARE
  reset_count integer;
BEGIN
  UPDATE "photo_jobs"
     SET state = 'failed',
         last_error = 'migration_face_scan_v1_reset',
         failed_at = now(),
         updated_at = now()
   WHERE state = 'claimed' AND kind = 'detect';
  GET DIAGNOSTICS reset_count = ROW_COUNT;
  IF reset_count > 0 THEN
    RAISE NOTICE 'face_scan_v1: force-failed % stale claimed detect jobs (drain incomplete?)', reset_count;
  END IF;
END $$;--> statement-breakpoint

INSERT INTO "photo_jobs" (photo_id, kind, state)
SELECT id, 'detect', 'queued'
  FROM "photos"
 WHERE processing_state IN ('ready', 'processing')
   AND deleted_at IS NULL
ON CONFLICT DO NOTHING;
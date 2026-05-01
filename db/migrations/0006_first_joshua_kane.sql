CREATE TABLE "face_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"representative_detection_id" uuid,
	"representative_embedding" vector(128) NOT NULL,
	"member_count" integer DEFAULT 1 NOT NULL,
	"claimed_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "face_detections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"bbox_x1" real NOT NULL,
	"bbox_y1" real NOT NULL,
	"bbox_x2" real NOT NULL,
	"bbox_y2" real NOT NULL,
	"confidence" real NOT NULL,
	"landmarks_json" jsonb NOT NULL,
	"embedding" vector(128) NOT NULL,
	"cluster_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "face_clusters" ADD CONSTRAINT "face_clusters_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_clusters" ADD CONSTRAINT "face_clusters_claimed_by_user_id_users_id_fk" FOREIGN KEY ("claimed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_detections" ADD CONSTRAINT "face_detections_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_detections" ADD CONSTRAINT "face_detections_cluster_id_face_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."face_clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "face_detections_embedding_idx" ON "face_detections" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists=100);--> statement-breakpoint
-- Circular back-reference: face_clusters.representative_detection_id → face_detections.id.
-- Added after both tables and all other FKs exist to avoid dependency-ordering issues.
ALTER TABLE "face_clusters" ADD CONSTRAINT "face_clusters_representative_detection_id_fk" FOREIGN KEY ("representative_detection_id") REFERENCES "public"."face_detections"("id") ON DELETE set null ON UPDATE no action;
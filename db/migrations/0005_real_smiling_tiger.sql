CREATE TABLE "photo_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"photo_id" uuid NOT NULL,
	"kind" text DEFAULT 'detect' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"claimed_at" timestamp,
	"claimed_by" text,
	"last_error" text,
	"last_error_at" timestamp,
	"succeeded_at" timestamp,
	"failed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "photo_jobs_state_check" CHECK (state IN ('queued','claimed','succeeded','failed'))
);
--> statement-breakpoint
ALTER TABLE "photo_jobs" ADD CONSTRAINT "photo_jobs_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_jobs_photo_id_idx" ON "photo_jobs" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "photo_jobs_state_created_idx" ON "photo_jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "photo_jobs_photo_id_kind_active_uidx" ON "photo_jobs" USING btree ("photo_id","kind") WHERE state IN ('queued','claimed','succeeded');--> statement-breakpoint
CREATE VIEW "public"."failed_photo_jobs_recent" AS (select "photo_jobs"."id", "photo_jobs"."photo_id", "photos"."event_id", "photos"."uploader_user_id", "photo_jobs"."attempts", "photo_jobs"."last_error", "photo_jobs"."last_error_at", "photo_jobs"."failed_at" from "photo_jobs" inner join "photos" on "photos"."id" = "photo_jobs"."photo_id" where ("photo_jobs"."state" = 'failed' and "photo_jobs"."failed_at" > now() - interval '7 days') order by "photo_jobs"."failed_at" desc);
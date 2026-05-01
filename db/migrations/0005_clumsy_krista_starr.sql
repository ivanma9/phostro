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
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_jobs" ADD CONSTRAINT "photo_jobs_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_jobs_photo_id_idx" ON "photo_jobs" USING btree ("photo_id");--> statement-breakpoint
CREATE INDEX "photo_jobs_state_idx" ON "photo_jobs" USING btree ("state");
--> statement-breakpoint
ALTER TABLE "photo_jobs" ADD CONSTRAINT "photo_jobs_state_check" CHECK (state IN ('queued', 'claimed', 'succeeded', 'failed'));
--> statement-breakpoint
CREATE UNIQUE INDEX "photo_jobs_photo_id_kind_active_uidx" ON "photo_jobs" ("photo_id", "kind") WHERE state IN ('queued', 'claimed', 'succeeded');
--> statement-breakpoint
CREATE OR REPLACE VIEW failed_photo_jobs_recent AS
SELECT pj.id, pj.photo_id, p.event_id, p.uploader_user_id,
       pj.attempts, pj.last_error, pj.last_error_at, pj.failed_at
FROM photo_jobs pj
JOIN photos p ON p.id = pj.photo_id
WHERE pj.state = 'failed' AND pj.failed_at > now() - interval '7 days'
ORDER BY pj.failed_at DESC;
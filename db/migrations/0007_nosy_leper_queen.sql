CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"max_uploads" integer,
	"upload_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DROP INDEX "photos_uploader_event_idx";--> statement-breakpoint
ALTER TABLE "photos" ALTER COLUMN "uploader_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "uploader_token" text;--> statement-breakpoint
ALTER TABLE "photos" ADD COLUMN "contributor_display_name" text;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_uidx" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_event_id_idx" ON "share_links" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "photos_uploader_event_idx" ON "photos" USING btree ("uploader_user_id","event_id") WHERE uploader_user_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_authorship_check" CHECK ((uploader_user_id IS NOT NULL) <> (uploader_token IS NOT NULL));
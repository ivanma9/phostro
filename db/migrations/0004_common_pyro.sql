CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"uploader_user_id" uuid NOT NULL,
	"processing_state" text DEFAULT 'pending' NOT NULL,
	"pending_expires_at" timestamp,
	"processing_claimed_at" timestamp,
	"pending_key" text,
	"r2_key_original" text,
	"r2_key_preview" text,
	"declared_mime_type" text NOT NULL,
	"declared_size_bytes" integer NOT NULL,
	"original_filename" text,
	"width" integer,
	"height" integer,
	"size_bytes_original" integer,
	"taken_at" timestamp,
	"uploaded_at" timestamp,
	"has_detected_faces" boolean,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_uploader_user_id_users_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photos_event_id_idx" ON "photos" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "photos_event_taken_at_idx" ON "photos" USING btree ("event_id","taken_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "photos_event_state_idx" ON "photos" USING btree ("event_id","processing_state");--> statement-breakpoint
CREATE INDEX "photos_uploader_event_idx" ON "photos" USING btree ("uploader_user_id","event_id");
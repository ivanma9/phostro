ALTER TABLE "magic_link_tokens" ADD COLUMN "intended_redirect" text;--> statement-breakpoint
CREATE INDEX "magic_link_tokens_contact_idx" ON "magic_link_tokens" USING btree ("contact");
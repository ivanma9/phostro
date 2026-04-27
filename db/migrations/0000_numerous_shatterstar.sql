CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact" text NOT NULL,
	"contact_type" text NOT NULL,
	"face_embedding" vector(128),
	"face_quality_score" integer,
	"face_enrolled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_contact_unique" UNIQUE("contact")
);

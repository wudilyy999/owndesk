ALTER TABLE "companion_messages" ADD COLUMN "reveal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companion_messages" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "typing_pace" text DEFAULT 'natural' NOT NULL;
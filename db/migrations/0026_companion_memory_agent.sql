ALTER TABLE "companions" ADD COLUMN "memory_organized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "memory_organize_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "kind" text DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "summary_id" text;--> statement-breakpoint
ALTER TABLE "memory_changes" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_summary_id_memories_id_fk" FOREIGN KEY ("summary_id") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;
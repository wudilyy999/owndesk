CREATE TABLE "memory_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"op" text NOT NULL,
	"actor" text NOT NULL,
	"origin" text DEFAULT 'chat' NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"message_id" text,
	"source_text" text,
	"created_at" timestamp with time zone NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_changes_agent_idx" ON "memory_changes" USING btree ("agent_id","created_at");--> statement-breakpoint
-- Similar notes no longer ask the person: old pending suggestions and their chat cards are closed,
-- the rows themselves stay (harmless history).
UPDATE "memory_suggestions" SET "status" = 'dropped' WHERE "status" = 'pending';--> statement-breakpoint
UPDATE "companion_messages" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || '{"status":"dropped"}'::jsonb WHERE "kind" = 'memory_merge' AND "metadata"->>'status' = 'pending';

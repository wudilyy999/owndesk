CREATE TABLE "routine_commands" (
	"key" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "event_trigger" jsonb;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "watch_state" jsonb;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "next_watch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "webhook_cipher" text;
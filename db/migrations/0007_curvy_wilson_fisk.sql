CREATE TABLE "telegram_connection" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"owner_id" text NOT NULL,
	"generation" text NOT NULL,
	"bot_id" text,
	"bot_username" text,
	"cursor" integer DEFAULT 0 NOT NULL,
	"pair_code" text,
	"pair_expires_at" timestamp with time zone,
	"user_id" text,
	"chat_id" text,
	"owner_name" text,
	"paired_at" timestamp with time zone,
	"agent_id" text,
	"thread_id" text,
	"task_id" text,
	"last_poll_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "single_telegram_connection" CHECK ("telegram_connection"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "telegram_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"generation" text NOT NULL,
	"key" text NOT NULL,
	"chat_id" text NOT NULL,
	"method" text DEFAULT 'sendMessage' NOT NULL,
	"payload" jsonb NOT NULL,
	"context" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"message_id" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"uncertain_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"generation" text NOT NULL,
	"update_id" integer NOT NULL,
	"sender_id" text,
	"command" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telegram_updates_generation_update_id_pk" PRIMARY KEY("generation","update_id")
);
--> statement-breakpoint
ALTER TABLE "telegram_connection" ADD CONSTRAINT "telegram_connection_owner_id_owners_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection" ADD CONSTRAINT "telegram_connection_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection" ADD CONSTRAINT "telegram_connection_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connection" ADD CONSTRAINT "telegram_connection_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_outbox_key_idx" ON "telegram_outbox" USING btree ("generation","key");--> statement-breakpoint
CREATE INDEX "telegram_outbox_pending_idx" ON "telegram_outbox" USING btree ("status","created_at");
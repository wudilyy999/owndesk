CREATE TABLE "companion_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"role" text NOT NULL,
	"kind" text DEFAULT 'chat' NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"channel" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companion_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" integer,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companions" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"persona" jsonb NOT NULL,
	"mode" text DEFAULT 'friend' NOT NULL,
	"adult_confirmed_at" timestamp with time zone,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"shares_paused" boolean DEFAULT false NOT NULL,
	"max_shares_per_day" integer DEFAULT 2 NOT NULL,
	"quiet_start" text DEFAULT '23:00' NOT NULL,
	"quiet_end" text DEFAULT '08:00' NOT NULL,
	"life_enabled" boolean DEFAULT false NOT NULL,
	"life_times" jsonb DEFAULT '["10:30","20:30"]'::jsonb NOT NULL,
	"life_daily_budget_micros" integer DEFAULT 100000 NOT NULL,
	"life_session_max_steps" integer DEFAULT 25 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "life_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"task_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "life_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"activity_id" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "source" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "companion_messages" ADD CONSTRAINT "companion_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_usage" ADD CONSTRAINT "companion_usage_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companions" ADD CONSTRAINT "companions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "life_activities" ADD CONSTRAINT "life_activities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "life_activities" ADD CONSTRAINT "life_activities_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "life_shares" ADD CONSTRAINT "life_shares_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "life_shares" ADD CONSTRAINT "life_shares_activity_id_life_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."life_activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companion_messages_agent_idx" ON "companion_messages" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "companion_usage_agent_idx" ON "companion_usage" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "life_activities_agent_idx" ON "life_activities" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "life_shares_status_idx" ON "life_shares" USING btree ("agent_id","status","created_at");
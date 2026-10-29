CREATE TABLE "desktop_tickets" (
	"token" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"mode" text NOT NULL,
	"epoch" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"segment_no" integer NOT NULL,
	"action_no" integer,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"decision" text,
	"response" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workstation_control" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"container_name" text NOT NULL,
	"connection_secret" text NOT NULL,
	"mode" text DEFAULT 'idle' NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"boot_id" text,
	"active_task_id" text,
	"active_segment" integer,
	"active_action_id" text,
	"desired_mode" text,
	"request_id" text,
	"last_error" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workstation_control_containerName_unique" UNIQUE("container_name")
);
--> statement-breakpoint
ALTER TABLE "task_actions" ADD COLUMN "dispatch_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "task_actions" ADD COLUMN "epoch" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "task_actions" ADD COLUMN "boot_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_tickets" ADD CONSTRAINT "desktop_tickets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_requests" ADD CONSTRAINT "task_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_requests" ADD CONSTRAINT "task_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstation_control" ADD CONSTRAINT "workstation_control_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstation_control" ADD CONSTRAINT "workstation_control_active_task_id_tasks_id_fk" FOREIGN KEY ("active_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_requests_pending_idx" ON "task_requests" USING btree ("status");
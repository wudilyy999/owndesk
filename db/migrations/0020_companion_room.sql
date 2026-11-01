CREATE TABLE "coview_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"task_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "rhythm" jsonb DEFAULT '{"sleep":{"start":"23:30","end":"07:30"},"nap":null,"away":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "desktop_tickets" ADD COLUMN "watch_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "life_activities" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "life_activities" ADD COLUMN "image_path" text;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "coview_requests" ADD CONSTRAINT "coview_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coview_requests" ADD CONSTRAINT "coview_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coview_requests_agent_idx" ON "coview_requests" USING btree ("agent_id","status","created_at");
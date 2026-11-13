CREATE TABLE "objective_rounds" (
	"id" text PRIMARY KEY NOT NULL,
	"objective_id" text NOT NULL,
	"round_no" integer NOT NULL,
	"input" jsonb NOT NULL,
	"task_id" text,
	"verdict" text,
	"summary" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"unknown_cost" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "objective_rounds_taskId_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "objectives" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"done_criteria" text DEFAULT '' NOT NULL,
	"completion_contract" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"budget" jsonb NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"proposal_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "objectives_proposalId_unique" UNIQUE("proposal_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "objective_id" text;--> statement-breakpoint
ALTER TABLE "objective_rounds" ADD CONSTRAINT "objective_rounds_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objective_rounds" ADD CONSTRAINT "objective_rounds_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "objective_rounds_round_idx" ON "objective_rounds" USING btree ("objective_id","round_no");--> statement-breakpoint
CREATE INDEX "objectives_status_idx" ON "objectives" USING btree ("status");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_objective_id_objectives_id_fk" FOREIGN KEY ("objective_id") REFERENCES "public"."objectives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_objective_idx" ON "tasks" USING btree ("objective_id");
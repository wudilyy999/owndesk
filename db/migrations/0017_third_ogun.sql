CREATE TABLE "task_workflow_runs" (
	"task_id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"purpose" text NOT NULL,
	"parameters" jsonb NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"environment" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "validated_environment" jsonb;--> statement-breakpoint
ALTER TABLE "task_workflow_runs" ADD CONSTRAINT "task_workflow_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_workflow_runs" ADD CONSTRAINT "task_workflow_runs_version_id_workflow_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_workflow_runs_version_idx" ON "task_workflow_runs" USING btree ("version_id","created_at");
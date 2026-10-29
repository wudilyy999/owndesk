CREATE TABLE "workflow_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"revision" integer NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"source_task_id" text NOT NULL,
	"compilation_task_id" text NOT NULL,
	"status" text NOT NULL,
	"environment" jsonb,
	"plan" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workflow_versions_compilationTaskId_unique" UNIQUE("compilation_task_id"),
	CONSTRAINT "workflow_versions_status_check" CHECK ("workflow_versions"."status" in ('draft','verifying','ready','retired','rejected'))
);
--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_compilation_task_id_tasks_id_fk" FOREIGN KEY ("compilation_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_revision_idx" ON "workflow_versions" USING btree ("workflow_id","revision");--> statement-breakpoint
CREATE INDEX "workflow_versions_owner_idx" ON "workflow_versions" USING btree ("owner_id","created_at");
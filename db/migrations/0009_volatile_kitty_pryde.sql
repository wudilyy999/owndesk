ALTER TABLE "routine_runs" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "plan_version" integer;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "plan_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "missed_run_policy" text DEFAULT 'latest' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "date_range" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "completion_contract" jsonb DEFAULT '{"requireHumanReview":false}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "budget" jsonb DEFAULT '{"maxSteps":40}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_runs_request_idx" ON "routine_runs" USING btree ("request_key");--> statement-breakpoint
UPDATE routines SET time_zone=(SELECT time_zone FROM owners LIMIT 1) WHERE EXISTS(SELECT 1 FROM owners);--> statement-breakpoint
UPDATE routines SET enabled=false,next_run_at=NULL,last_error='Review the explicit time zone and re-enable after migrating the legacy scheduler';--> statement-breakpoint
UPDATE routines SET enabled=false,next_run_at=NULL,last_error='Legacy squad routines require the sequential delegation migration' WHERE squad_id IS NOT NULL;--> statement-breakpoint
UPDATE routine_runs SET status='failed',detail='Legacy in-memory executor has no durable task receipt',finished_at=now() WHERE status='running' AND task_id IS NULL;

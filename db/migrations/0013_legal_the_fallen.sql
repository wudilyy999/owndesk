ALTER TABLE "task_segments" ADD COLUMN "snapshot" jsonb;
--> statement-breakpoint
UPDATE "task_segments" s SET "snapshot"=jsonb_build_object('config',t.config_snapshot) FROM "tasks" t WHERE t.id=s.task_id;
--> statement-breakpoint
ALTER TABLE "task_segments" ALTER COLUMN "snapshot" SET NOT NULL;

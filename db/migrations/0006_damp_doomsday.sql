ALTER TABLE "tasks" ADD COLUMN "thread_turn" integer;--> statement-breakpoint
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY thread_id ORDER BY created_at,id)::integer AS turn
  FROM tasks WHERE thread_id IS NOT NULL
)
UPDATE tasks SET thread_turn=ordered.turn FROM ordered WHERE tasks.id=ordered.id;
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_thread_turn_idx" ON "tasks" USING btree ("thread_id","thread_turn");

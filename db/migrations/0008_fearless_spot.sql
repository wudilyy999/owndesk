CREATE TABLE "task_model_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "task_model_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"task_id" text NOT NULL,
	"segment_no" integer NOT NULL,
	"decision_no" integer NOT NULL,
	"attempt_no" integer NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"price_snapshot" jsonb,
	"usage" jsonb,
	"cost_micros" bigint,
	"reconciled_cost_micros" bigint,
	"reconciliation_note" text,
	"reconciled_at" timestamp with time zone,
	"legacy" boolean DEFAULT false NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task_model_decisions" ALTER COLUMN "cost_micros" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "task_model_attempts" ADD CONSTRAINT "task_model_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_attempt_key_idx" ON "task_model_attempts" USING btree ("task_id","segment_no","decision_no","attempt_no");--> statement-breakpoint
CREATE INDEX "model_attempt_started_idx" ON "task_model_attempts" USING btree ("started_at");
--> statement-breakpoint
-- Backfill historical attempts. Retry timestamps were not stored; preserve the original recorded time and label legacy rows.
INSERT INTO task_model_attempts(task_id,segment_no,decision_no,attempt_no,model,status,usage,cost_micros,legacy,error,started_at,finished_at)
SELECT d.task_id,d.segment_no,d.decision_no,n,t.config_snapshot->>'model',
  CASE WHEN n=d.attempts AND d.status='succeeded' THEN 'succeeded' ELSE 'unknown' END,
  CASE WHEN n=d.attempts AND d.status='succeeded' THEN d.result->'usage' ELSE NULL END,
  CASE WHEN n=d.attempts AND d.status='succeeded' THEN d.cost_micros ELSE NULL END,
  true,CASE WHEN n=d.attempts THEN d.error ELSE 'Legacy attempt; exact retry timestamp and billing receipt unavailable' END,
  d.created_at,CASE WHEN n=d.attempts THEN d.finished_at ELSE NULL END
FROM task_model_decisions d JOIN tasks t ON t.id=d.task_id CROSS JOIN LATERAL generate_series(1,d.attempts) AS n
ON CONFLICT(task_id,segment_no,decision_no,attempt_no) DO NOTHING;

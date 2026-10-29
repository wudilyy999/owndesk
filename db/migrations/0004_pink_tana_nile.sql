CREATE TABLE "task_model_decisions" (
	"task_id" text NOT NULL,
	"segment_no" integer NOT NULL,
	"decision_no" integer NOT NULL,
	"epoch" integer NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"result" jsonb,
	"cost_micros" integer,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "task_model_decisions_task_id_segment_no_decision_no_pk" PRIMARY KEY("task_id","segment_no","decision_no")
);
--> statement-breakpoint
ALTER TABLE "task_model_decisions" ADD CONSTRAINT "task_model_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
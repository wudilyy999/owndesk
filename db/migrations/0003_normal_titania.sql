CREATE TABLE "task_action_attempts" (
	"task_id" text NOT NULL,
	"segment_no" integer NOT NULL,
	"action_no" integer NOT NULL,
	"attempt_no" integer NOT NULL,
	"dispatch_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"boot_id" text NOT NULL,
	"status" text NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "task_action_attempts_task_id_segment_no_action_no_attempt_no_pk" PRIMARY KEY("task_id","segment_no","action_no","attempt_no"),
	CONSTRAINT "task_action_attempts_dispatchId_unique" UNIQUE("dispatch_id")
);
--> statement-breakpoint
ALTER TABLE "task_action_attempts" ADD CONSTRAINT "task_action_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
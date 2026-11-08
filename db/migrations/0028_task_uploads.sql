CREATE TABLE "task_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_uploads" ADD CONSTRAINT "task_uploads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_uploads_owner_agent_idx" ON "task_uploads" USING btree ("owner_id","agent_id");
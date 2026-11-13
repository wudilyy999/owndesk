CREATE TABLE "agent_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"kind" text DEFAULT 'upstream' NOT NULL,
	"parent_id" text,
	"source_revision" text DEFAULT 'unknown' NOT NULL,
	"git_commit" text,
	"web_image_id" text NOT NULL,
	"worker_image_id" text NOT NULL,
	"images" jsonb NOT NULL,
	"status" text DEFAULT 'retained' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"promoted_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" text PRIMARY KEY NOT NULL,
	"from_version_id" text,
	"to_version_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"phase" text DEFAULT 'switching' NOT NULL,
	"reason" text,
	"health_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"related_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_parent_id_agent_versions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."agent_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_from_version_id_agent_versions_id_fk" FOREIGN KEY ("from_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_to_version_id_agent_versions_id_fk" FOREIGN KEY ("to_version_id") REFERENCES "public"."agent_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_images_idx" ON "agent_versions" USING btree ("web_image_id","worker_image_id");--> statement-breakpoint
CREATE INDEX "deployments_started_idx" ON "deployments" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_running_idx" ON "deployments" USING btree ("status") WHERE "deployments"."status" = 'running';
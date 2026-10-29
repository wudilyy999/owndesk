ALTER TABLE "workflow_versions" ALTER COLUMN "source_task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_versions" ALTER COLUMN "compilation_task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "imported_package" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "import_request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_import_request_idx" ON "workflow_versions" USING btree ("owner_id","import_request_id");--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_origin_check" CHECK ((("workflow_versions"."source_task_id" IS NOT NULL AND "workflow_versions"."compilation_task_id" IS NOT NULL) OR "workflow_versions"."imported_package" IS NOT NULL) AND ("workflow_versions"."import_request_id" IS NULL OR "workflow_versions"."imported_package" IS NOT NULL));
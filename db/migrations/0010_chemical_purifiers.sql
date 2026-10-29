ALTER TABLE "vault_items" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "scope_task_id" text;--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "consumed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "vault_items" SET "expires_at"="created_at"+interval '1 day' WHERE "ephemeral";--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_scope_task_id_tasks_id_fk" FOREIGN KEY ("scope_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;

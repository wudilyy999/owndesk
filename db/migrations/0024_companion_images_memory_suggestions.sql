CREATE TABLE "companion_images" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"path" text,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"description" text,
	"sensitive" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"other_id" text NOT NULL,
	"merged_text" text NOT NULL,
	"score" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companion_images" ADD CONSTRAINT "companion_images_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_suggestions" ADD CONSTRAINT "memory_suggestions_other_id_memories_id_fk" FOREIGN KEY ("other_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companion_images_agent_idx" ON "companion_images" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "companion_images_expiry_idx" ON "companion_images" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_suggestions_pair_idx" ON "memory_suggestions" USING btree ("memory_id","other_id");--> statement-breakpoint
CREATE INDEX "memory_suggestions_agent_idx" ON "memory_suggestions" USING btree ("agent_id","status");
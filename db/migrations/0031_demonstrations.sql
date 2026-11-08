CREATE TABLE "demonstrations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"epoch" integer NOT NULL,
	"status" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demonstrations" ADD CONSTRAINT "demonstrations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
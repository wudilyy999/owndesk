CREATE TABLE "push_deliveries" (
	"message_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"devices" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "push_preview" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companions" ADD COLUMN "web_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_message_id_companion_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."companion_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_agent_idx" ON "push_subscriptions" USING btree ("agent_id");
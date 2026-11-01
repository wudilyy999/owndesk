CREATE TABLE "channel_inbound" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"event_key" text NOT NULL,
	"external_id" text NOT NULL,
	"text" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_links" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"message_id" text,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"context" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"not_before" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "channel_pair_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_outbox" ADD CONSTRAINT "channel_outbox_link_id_channel_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."channel_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_outbox" ADD CONSTRAINT "channel_outbox_message_id_companion_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."companion_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pair_codes" ADD CONSTRAINT "channel_pair_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_inbound_event_idx" ON "channel_inbound" USING btree ("channel","event_key");--> statement-breakpoint
CREATE INDEX "channel_inbound_status_idx" ON "channel_inbound" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_external_idx" ON "channel_links" USING btree ("channel","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_agent_idx" ON "channel_links" USING btree ("agent_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_outbox_message_idx" ON "channel_outbox" USING btree ("link_id","message_id");--> statement-breakpoint
CREATE INDEX "channel_outbox_status_idx" ON "channel_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_pair_codes_hash_idx" ON "channel_pair_codes" USING btree ("code_hash");
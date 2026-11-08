CREATE TABLE "app_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config_cipher" text NOT NULL,
	"tokens_cipher" text,
	"oauth_session_cipher" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);

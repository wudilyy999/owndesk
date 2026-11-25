CREATE TABLE "library_entries" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL,
  "kind" text NOT NULL CHECK (kind IN ('note','followup')),
  "title" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "source_kind" text,
  "source_id" text,
  "done" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "library_owner_idx" ON "library_entries" ("owner_id", "updated_at");

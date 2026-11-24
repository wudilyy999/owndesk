ALTER TABLE "objective_rounds" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "schedule_plan" jsonb;--> statement-breakpoint
ALTER TABLE "objectives" ADD COLUMN "next_round_at" timestamp with time zone;
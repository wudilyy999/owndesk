CREATE SEQUENCE "public"."channel_delivery_sequence" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
-- Existing links and messages keep their historical cutoff. Only new inserts consume a slot.
ALTER TABLE "channel_links" ADD COLUMN "delivery_order" bigint;--> statement-breakpoint
ALTER TABLE "companion_messages" ADD COLUMN "delivery_order" bigint;--> statement-breakpoint
ALTER TABLE "channel_links" ALTER COLUMN "delivery_order" SET DEFAULT nextval('channel_delivery_sequence');--> statement-breakpoint
ALTER TABLE "companion_messages" ALTER COLUMN "delivery_order" SET DEFAULT nextval('channel_delivery_sequence');

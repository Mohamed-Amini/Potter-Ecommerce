ALTER TABLE "order_requests" DROP COLUMN "contact_method";--> statement-breakpoint
ALTER TABLE "order_requests" DROP COLUMN "contact_value";--> statement-breakpoint
DROP TYPE "public"."contact_method";
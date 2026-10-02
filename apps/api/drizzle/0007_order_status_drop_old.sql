ALTER TABLE "order_requests" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "order_requests" ALTER COLUMN "status" SET DEFAULT 'awaiting_payment'::text;--> statement-breakpoint
DROP TYPE "public"."order_status";--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('awaiting_payment', 'paid', 'shipped', 'completed', 'expired', 'cancelled');--> statement-breakpoint
ALTER TABLE "order_requests" ALTER COLUMN "status" SET DEFAULT 'awaiting_payment'::"public"."order_status";--> statement-breakpoint
ALTER TABLE "order_requests" ALTER COLUMN "status" SET DATA TYPE "public"."order_status" USING "status"::"public"."order_status";--> statement-breakpoint
ALTER TABLE "order_requests" DROP COLUMN "contacted_at";--> statement-breakpoint
ALTER TABLE "order_requests" DROP COLUMN "confirmed_at";
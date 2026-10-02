ALTER TABLE "order_requests" ADD COLUMN "paid_at" timestamp;--> statement-breakpoint
ALTER TABLE "order_requests" ADD COLUMN "expired_at" timestamp;--> statement-breakpoint
ALTER TABLE "order_requests" ADD COLUMN "shipped_at" timestamp;
ALTER TABLE "order_requests" ADD COLUMN "customer_email" varchar(254) NOT NULL;--> statement-breakpoint
ALTER TABLE "order_requests" ADD COLUMN "customer_phone" varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE "order_requests" ADD COLUMN "customer_telegram" varchar(32);
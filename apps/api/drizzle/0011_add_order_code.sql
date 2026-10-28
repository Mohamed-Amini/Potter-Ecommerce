ALTER TABLE "order_requests" ADD COLUMN "order_code" varchar(6) NOT NULL;--> statement-breakpoint
ALTER TABLE "order_requests" ADD CONSTRAINT "order_requests_order_code_unique" UNIQUE("order_code");
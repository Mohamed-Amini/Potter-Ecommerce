CREATE TYPE "public"."contact_method" AS ENUM('telegram', 'phone', 'email');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('new', 'contacted', 'confirmed', 'shipped', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "order_request_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_request_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name_snapshot" varchar(50) NOT NULL,
	"price_minor_snapshot" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_number" integer GENERATED ALWAYS AS IDENTITY (sequence name "order_requests_reference_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"customer_name" varchar(100) NOT NULL,
	"contact_method" "contact_method" NOT NULL,
	"contact_value" varchar(254) NOT NULL,
	"note" text,
	"items_total_minor" integer NOT NULL,
	"agreed_total_minor" integer,
	"status" "order_status" DEFAULT 'new' NOT NULL,
	"contacted_at" timestamp,
	"confirmed_at" timestamp,
	"completed_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "price_minor" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "order_request_items" ADD CONSTRAINT "order_request_items_order_request_id_order_requests_id_fk" FOREIGN KEY ("order_request_id") REFERENCES "public"."order_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_request_items" ADD CONSTRAINT "order_request_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
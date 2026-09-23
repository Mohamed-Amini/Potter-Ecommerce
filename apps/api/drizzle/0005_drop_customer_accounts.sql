ALTER TABLE "contact_messages" DROP CONSTRAINT "contact_messages_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "basket_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "baskets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "favourites" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "phone_verifications" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "basket_items" CASCADE;--> statement-breakpoint
DROP TABLE "baskets" CASCADE;--> statement-breakpoint
DROP TABLE "favourites" CASCADE;--> statement-breakpoint
DROP TABLE "phone_verifications" CASCADE;--> statement-breakpoint
DROP TABLE "sessions" CASCADE;--> statement-breakpoint
DROP TABLE "users" CASCADE;--> statement-breakpoint
ALTER TABLE "contact_messages" ALTER COLUMN "email" SET DATA TYPE varchar(254);--> statement-breakpoint
ALTER TABLE "contact_messages" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "price_pence";--> statement-breakpoint
DROP TYPE "public"."custom_order_status";

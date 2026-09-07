DROP INDEX "supplier_orders_order_supplier_uq";--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD COLUMN "warehouse_country" text DEFAULT 'US' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_variant_mappings" ADD COLUMN "delivery_max_days" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_orders_order_supplier_origin_uq" ON "supplier_orders" USING btree ("order_id","supplier","warehouse_country");
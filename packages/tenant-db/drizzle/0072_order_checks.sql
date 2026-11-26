CREATE TABLE `restaurant_order_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`revision` integer NOT NULL,
	`lines` text NOT NULL,
	`totals` text NOT NULL,
	`changes` text,
	`reason` text,
	`actor_id` text NOT NULL,
	`actor_name` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restaurant_order_revisions_order_rev_unique` ON `restaurant_order_revisions` (`order_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `restaurant_order_revisions_idempotency_unique` ON `restaurant_order_revisions` (`order_id`,`idempotency_key`) WHERE "restaurant_order_revisions"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX `idx_restaurant_order_revisions_order` ON `restaurant_order_revisions` (`order_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `tax_exempt_ref` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `tax_exempt_org` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_address` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_unit` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_notes` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_zone_id` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_zone_name` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_fee_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_lat` real;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_lng` real;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_postal_code` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_min_override_by_staff_id` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `delivery_min_override_by_staff_name` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `party_size` integer;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `service_charge_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `service_charge_tax_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `service_charge_label` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `service_charge_removed_by_staff_id` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `service_charge_removed_by_staff_name` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `service_charge_removed_reason` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `service_charge_removed_at` integer;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `balance_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_pos_orders_delivery_address` ON `pos_orders` (`updated_at`) WHERE "pos_orders"."delivery_address" is not null;--> statement-breakpoint
ALTER TABLE `pos_payments` ADD `line_shares` text;--> statement-breakpoint
ALTER TABLE `pos_payments` ADD `check_number` integer;--> statement-breakpoint
ALTER TABLE `pos_payments` ADD `tip_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_payments` ADD `loyalty_customer_id` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `time_change_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `tax_exempt_ref` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `tax_exempt_org` text;--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_created_at` ON `restaurant_orders` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_fulfillment_created` ON `restaurant_orders` (`fulfillment`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_payment_method_created` ON `restaurant_orders` (`payment_method`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_tax_exempt` ON `restaurant_orders` (`tax_exempt_ref`) WHERE "restaurant_orders"."tax_exempt_ref" is not null;
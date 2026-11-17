CREATE TABLE `order_dish_daily_counts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`location_id` text NOT NULL,
	`business_date` text NOT NULL,
	`catalog_key` text NOT NULL,
	`limit_units` integer NOT NULL,
	`sold_units` integer DEFAULT 0 NOT NULL,
	`held_units` integer DEFAULT 0 NOT NULL,
	`topped_up_units` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_dish_daily_counts_key` ON `order_dish_daily_counts` (`org_id`,`location_id`,`business_date`,`catalog_key`);--> statement-breakpoint
CREATE INDEX `idx_order_dish_daily_counts_location_day` ON `order_dish_daily_counts` (`location_id`,`business_date`);--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `packaging_fee_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `packaging_fee_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `packaging_fee_tax_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `packaging_fee_label` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `pickup_instructions` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `utensils_requested` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `large_order_extra_minutes` integer DEFAULT 0 NOT NULL;
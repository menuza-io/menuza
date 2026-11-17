CREATE TABLE `order_dish_daily_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`location_id` text NOT NULL,
	`business_date` text NOT NULL,
	`catalog_key` text NOT NULL,
	`units` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_dish_daily_claims_order_key` ON `order_dish_daily_claims` (`order_id`,`catalog_key`);--> statement-breakpoint
CREATE INDEX `idx_order_dish_daily_claims_day` ON `order_dish_daily_claims` (`location_id`,`business_date`,`catalog_key`,`state`);--> statement-breakpoint
CREATE TABLE `order_dish_daily_topups` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`business_date` text NOT NULL,
	`catalog_key` text NOT NULL,
	`topped_up_units` integer DEFAULT 0 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_dish_daily_topups_key` ON `order_dish_daily_topups` (`location_id`,`business_date`,`catalog_key`);--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `packaging_fee_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `packaging_fee_tax_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `packaging_fee_label` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `pickup_instructions` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `utensils_requested` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `large_order_extra_minutes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Daily dish claims (#409) follow their order: held while an online order waits
-- for payment, sold once it counts, released when it is cancelled, rejected,
-- expired or in payment review. Hand-written (drizzle-kit does not model
-- triggers); keep in step with `dailyDishClaimState` in @repo/common.
DROP TRIGGER IF EXISTS `order_dish_daily_claims_sync`;
--> statement-breakpoint
CREATE TRIGGER `order_dish_daily_claims_sync` AFTER UPDATE OF `status`, `payment_method`, `payment_status` ON `restaurant_orders`
BEGIN
	UPDATE `order_dish_daily_claims`
	SET `state` = CASE
		WHEN NEW.`status` IN ('pending_acceptance', 'accepted', 'preparing', 'ready', 'completed')
			THEN CASE WHEN NEW.`payment_method` = 'online' AND NEW.`payment_status` = 'pending' THEN 'held' ELSE 'sold' END
		ELSE 'released'
	END,
		`updated_at` = (cast(strftime('%s', 'now') as integer) * 1000)
	WHERE `order_id` = NEW.`id`
		AND `state` <> CASE
		WHEN NEW.`status` IN ('pending_acceptance', 'accepted', 'preparing', 'ready', 'completed')
			THEN CASE WHEN NEW.`payment_method` = 'online' AND NEW.`payment_status` = 'pending' THEN 'held' ELSE 'sold' END
		ELSE 'released'
	END;
END;

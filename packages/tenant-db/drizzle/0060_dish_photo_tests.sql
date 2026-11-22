CREATE TABLE `dish_photo_daily` (
	`day` text NOT NULL,
	`test_id` text NOT NULL,
	`item_id` text NOT NULL,
	`variant` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`adds` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `test_id`, `item_id`, `variant`)
);
--> statement-breakpoint
CREATE INDEX `idx_dish_photo_daily_test` ON `dish_photo_daily` (`test_id`,`day`);--> statement-breakpoint
CREATE TABLE `dish_photo_order_lines` (
	`order_id` text NOT NULL,
	`test_id` text NOT NULL,
	`item_id` text NOT NULL,
	`variant` text NOT NULL,
	PRIMARY KEY(`order_id`, `test_id`, `item_id`),
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_dish_photo_order_lines_test` ON `dish_photo_order_lines` (`test_id`,`variant`);
ALTER TABLE `shop_orders` ADD `location_id` text;--> statement-breakpoint
ALTER TABLE `shop_orders` ADD `fulfillment_type` text DEFAULT 'pickup' NOT NULL;--> statement-breakpoint
ALTER TABLE `shop_orders` ADD `kitchen_status` text DEFAULT 'placed' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shop_orders_location` ON `shop_orders` (`location_id`);--> statement-breakpoint
CREATE INDEX `idx_shop_orders_kitchen_status` ON `shop_orders` (`kitchen_status`);--> statement-breakpoint
CREATE TABLE `shop_order_line_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`menu_item_id` text,
	`name` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`line_total_cents` integer NOT NULL,
	`modifier_summary` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_shop_order_line_items_order` ON `shop_order_line_items` (`order_id`);--> statement-breakpoint
CREATE TABLE `menu_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE INDEX `idx_menu_categories_location` ON `menu_categories` (`location_id`);--> statement-breakpoint
CREATE INDEX `idx_menu_categories_sort` ON `menu_categories` (`location_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `menu_items` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price_cents` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`category_id`) REFERENCES `menu_categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_menu_items_category` ON `menu_items` (`category_id`);--> statement-breakpoint
CREATE INDEX `idx_menu_items_location` ON `menu_items` (`location_id`);--> statement-breakpoint
CREATE TABLE `menu_modifier_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`menu_item_id` text NOT NULL,
	`name` text NOT NULL,
	`min_selections` integer DEFAULT 0 NOT NULL,
	`max_selections` integer DEFAULT 1 NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`menu_item_id`) REFERENCES `menu_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_menu_modifier_groups_item` ON `menu_modifier_groups` (`menu_item_id`);--> statement-breakpoint
CREATE TABLE `menu_modifier_options` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `menu_modifier_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_menu_modifier_options_group` ON `menu_modifier_options` (`group_id`);

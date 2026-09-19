CREATE TABLE `menus` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE INDEX `idx_menus_location` ON `menus` (`location_id`);--> statement-breakpoint
CREATE TABLE `menu_category_links` (
	`id` text PRIMARY KEY NOT NULL,
	`menu_id` text NOT NULL,
	`category_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`menu_id`) REFERENCES `menus`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `menu_categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_menu_category_links_menu` ON `menu_category_links` (`menu_id`);--> statement-breakpoint
CREATE INDEX `idx_menu_category_links_category` ON `menu_category_links` (`category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_menu_category_links_unique` ON `menu_category_links` (`menu_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `menu_modifier_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`min_selections` integer DEFAULT 0 NOT NULL,
	`max_selections` integer DEFAULT 1 NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_menu_modifier_sets_location` ON `menu_modifier_sets` (`location_id`);--> statement-breakpoint
CREATE TABLE `menu_item_modifier_set_links` (
	`menu_item_id` text NOT NULL,
	`modifier_set_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY (`menu_item_id`, `modifier_set_id`),
	FOREIGN KEY (`menu_item_id`) REFERENCES `menu_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`modifier_set_id`) REFERENCES `menu_modifier_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_menu_item_modifier_set_item` ON `menu_item_modifier_set_links` (`menu_item_id`);--> statement-breakpoint
CREATE INDEX `idx_menu_item_modifier_set_set` ON `menu_item_modifier_set_links` (`modifier_set_id`);--> statement-breakpoint
INSERT INTO `menu_modifier_sets` (`id`, `location_id`, `name`, `min_selections`, `max_selections`, `required`, `sort_order`)
SELECT `g`.`id`, `i`.`location_id`, `g`.`name`, `g`.`min_selections`, `g`.`max_selections`, `g`.`required`, `g`.`sort_order`
FROM `menu_modifier_groups` AS `g`
INNER JOIN `menu_items` AS `i` ON `i`.`id` = `g`.`menu_item_id`;--> statement-breakpoint
INSERT INTO `menu_item_modifier_set_links` (`menu_item_id`, `modifier_set_id`, `sort_order`)
SELECT `menu_item_id`, `id`, `sort_order` FROM `menu_modifier_groups`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `menu_modifier_options_new` (
	`id` text PRIMARY KEY NOT NULL,
	`modifier_set_id` text NOT NULL,
	`name` text NOT NULL,
	`price_cents` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`modifier_set_id`) REFERENCES `menu_modifier_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `menu_modifier_options_new` (`id`, `modifier_set_id`, `name`, `price_cents`, `sort_order`)
SELECT `id`, `group_id`, `name`, `price_cents`, `sort_order` FROM `menu_modifier_options`;--> statement-breakpoint
DROP TABLE `menu_modifier_options`;--> statement-breakpoint
ALTER TABLE `menu_modifier_options_new` RENAME TO `menu_modifier_options`;--> statement-breakpoint
CREATE INDEX `idx_menu_modifier_options_set` ON `menu_modifier_options` (`modifier_set_id`);--> statement-breakpoint
DROP TABLE `menu_modifier_groups`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

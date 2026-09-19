ALTER TABLE `menus` ADD `menu_type` text DEFAULT 'olo' NOT NULL;
--> statement-breakpoint
ALTER TABLE `menus` ADD `show_calories` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `menus` ADD `instructions_enabled` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_categories` ADD `image_url` text;
--> statement-breakpoint
ALTER TABLE `menu_categories` ADD `upsell_category_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `image_url` text;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `points` integer;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `alcohol` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `gluten_free` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `vegetarian` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `allergens` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `calorie_min` integer;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `calorie_max` integer;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `popular` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `upsell` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `taxable` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_items` ADD `exclude_from_throttle` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_modifier_sets` ADD `display_type` text DEFAULT 'single-select' NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_modifier_sets` ADD `preselected_option_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `menu_modifier_options` ADD `description` text;
--> statement-breakpoint
ALTER TABLE `menu_modifier_options` ADD `active` integer DEFAULT true NOT NULL;

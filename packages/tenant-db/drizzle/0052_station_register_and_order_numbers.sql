DROP INDEX `restaurant_orders_number_unique`;--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_number` ON `restaurant_orders` (`number`);--> statement-breakpoint
ALTER TABLE `pos_order_lines` ADD `kind` text DEFAULT 'catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_order_lines` ADD `taxable` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_order_lines` ADD `kitchen_station_id` text;--> statement-breakpoint
ALTER TABLE `pos_shifts` ADD `closed_remotely_by_id` text;--> statement-breakpoint
ALTER TABLE `pos_shifts` ADD `closed_remotely_by_name` text;--> statement-breakpoint
ALTER TABLE `pos_shifts` ADD `remote_close_reason` text;
CREATE TABLE `pos_online_order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`location_id` text NOT NULL,
	`device_id` text NOT NULL,
	`staff_id` text,
	`action` text NOT NULL,
	`reason` text,
	`amount_cents` integer,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pos_online_order_events_order` ON `pos_online_order_events` (`order_id`,`action`);--> statement-breakpoint
CREATE INDEX `idx_pos_online_order_events_location` ON `pos_online_order_events` (`location_id`,`at`);--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `orders_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TRIGGER `pos_online_order_events_no_update` BEFORE UPDATE ON `pos_online_order_events`
BEGIN SELECT RAISE(ABORT, 'Online order history is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `pos_online_order_events_no_delete` BEFORE DELETE ON `pos_online_order_events`
BEGIN SELECT RAISE(ABORT, 'Online order history is append-only'); END;

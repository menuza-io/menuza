CREATE TABLE `order_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`location_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`last_sent_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_order_alerts_kind" CHECK("order_alerts"."kind" in ('placed', 'waiting', 'due_soon', 'payment_review', 'large_soon', 'kitchen_offline')),
	CONSTRAINT "chk_order_alerts_status" CHECK("order_alerts"."status" in ('pending', 'sent', 'dropped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_alerts_order_kind_unique` ON `order_alerts` (`order_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_order_alerts_due` ON `order_alerts` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_order_alerts_location_kind` ON `order_alerts` (`location_id`,`kind`,`created_at`);--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `battery_percent` integer;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `app_version` text;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `last_heartbeat_at` integer;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `offline_alerted_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `large_order` integer DEFAULT false NOT NULL;
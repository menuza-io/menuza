CREATE TABLE `order_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_order_messages_kind" CHECK("order_messages"."kind" in ('receipt', 'accepted', 'ready', 'out_for_delivery', 'cancelled', 'eta_changed')),
	CONSTRAINT "chk_order_messages_channel" CHECK("order_messages"."channel" in ('email', 'sms')),
	CONSTRAINT "chk_order_messages_status" CHECK("order_messages"."status" in ('queued', 'sent', 'failed', 'dropped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_messages_order_kind_channel_unique` ON `order_messages` (`order_id`,`kind`,`channel`);--> statement-breakpoint
CREATE INDEX `idx_order_messages_due` ON `order_messages` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_order_messages_sent` ON `order_messages` (`channel`,`status`,`sent_at`);--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `promised_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `promised_until` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `promised_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `promised_delay_minutes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `sms_updates_opt_in` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `guest_messages` text;
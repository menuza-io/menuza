ALTER TABLE `restaurant_orders` ADD `delivery_postal_code` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `delivery_lat` real;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `delivery_lng` real;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `scheduled_for` integer;
--> statement-breakpoint
CREATE TABLE `customer_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`topic` text NOT NULL,
	`channel` text NOT NULL,
	`source` text NOT NULL,
	`subscribed_at` integer NOT NULL,
	`unsubscribed_at` integer,
	`updated_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_customer_subscriptions_customer_topic_channel` ON `customer_subscriptions` (`customer_id`,`topic`,`channel`);--> statement-breakpoint
CREATE INDEX `idx_customer_subscriptions_topic_channel` ON `customer_subscriptions` (`topic`,`channel`,`unsubscribed_at`);

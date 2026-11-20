CREATE TABLE `customer_push_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`platform` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`token_hash` text NOT NULL,
	`app_id` text,
	`locale` text DEFAULT 'en' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_customer_push_devices_token` ON `customer_push_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_customer_push_devices_customer` ON `customer_push_devices` (`customer_id`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `customer_push_preferences` (
	`customer_id` text NOT NULL,
	`category` text NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`customer_id`, `category`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `push_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`customer_id` text NOT NULL,
	`device_id` text NOT NULL,
	`campaign_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error_code` text,
	`ticket_id` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`delivered_at` integer,
	`opened_at` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_push_messages_kind_ref_device` ON `push_messages` (`kind`,`ref`,`device_id`);--> statement-breakpoint
CREATE INDEX `idx_push_messages_campaign` ON `push_messages` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `idx_push_messages_customer` ON `push_messages` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_push_messages_receipt` ON `push_messages` (`status`,`ticket_id`);--> statement-breakpoint
ALTER TABLE `marketing_campaigns` ADD `push_image_url` text;--> statement-breakpoint
ALTER TABLE `marketing_campaigns` ADD `push_link` text;
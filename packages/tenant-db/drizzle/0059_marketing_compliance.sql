CREATE TABLE `short_link_clicks_daily` (
	`link_id` text NOT NULL,
	`day` text NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`link_id`, `day`),
	FOREIGN KEY (`link_id`) REFERENCES `short_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `short_links` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text,
	`label` text,
	`target_path` text NOT NULL,
	`utm_source` text,
	`utm_medium` text,
	`utm_campaign` text,
	`utm_content` text,
	`campaign_id` text,
	`step_id` text,
	`disabled_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_short_links_code` ON `short_links` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_short_links_kind_ref_target` ON `short_links` (`kind`,`ref`,`target_path`) WHERE "short_links"."ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_short_links_kind` ON `short_links` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `sms_inbound_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_message_id` text NOT NULL,
	`phone_hash` text NOT NULL,
	`keyword` text NOT NULL,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_sms_inbound_events_provider_message` ON `sms_inbound_events` (`provider_message_id`);--> statement-breakpoint
CREATE INDEX `idx_sms_inbound_events_received` ON `sms_inbound_events` (`received_at`);--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `attribution` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `attribution_source` text;
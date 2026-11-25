CREATE TABLE `print_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`protocol` text NOT NULL,
	`width_mm` integer DEFAULT 80 NOT NULL,
	`copies` integer DEFAULT 1 NOT NULL,
	`routes` text DEFAULT '{}' NOT NULL,
	`last_seen_at` integer,
	`status` text DEFAULT 'unknown' NOT NULL,
	`status_at` integer,
	`last_test_at` integer,
	`last_test_result` text,
	`revoked_at` integer,
	`revoked_by` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_print_devices_secret_hash` ON `print_devices` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `idx_print_devices_location` ON `print_devices` (`location_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `print_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`location_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`offered_at` integer,
	`printed_at` integer,
	`failed_reason` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `print_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_print_jobs_dedupe` ON `print_jobs` (`device_id`,`source_type`,`source_id`,`kind`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_print_jobs_device_status` ON `print_jobs` (`device_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_print_jobs_source` ON `print_jobs` (`source_type`,`source_id`);--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `age_confirmed` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `has_alcohol` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `guest_allergy` integer DEFAULT false NOT NULL;
CREATE TABLE `pos_device_health_daily` (
	`device_id` text NOT NULL,
	`day` text NOT NULL,
	`heartbeats` integer NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`app_version` text,
	`min_battery_pct` integer,
	`max_pending_uploads` integer,
	PRIMARY KEY(`device_id`, `day`),
	FOREIGN KEY (`device_id`) REFERENCES `pos_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pos_device_heartbeats` (
	`device_id` text NOT NULL,
	`minute_bucket` integer NOT NULL,
	`app_version` text,
	`browser` text,
	`battery_pct` integer,
	`charging` integer,
	`storage_used_mb` integer,
	`storage_quota_mb` integer,
	`pending_uploads` integer,
	`last_upload_at` integer,
	`printer_state` text,
	`drawer_opened_at` integer,
	`drawer_shift_id` text,
	PRIMARY KEY(`device_id`, `minute_bucket`),
	FOREIGN KEY (`device_id`) REFERENCES `pos_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pos_device_heartbeats_bucket` ON `pos_device_heartbeats` (`minute_bucket`);--> statement-breakpoint
CREATE TABLE `pos_terminal_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`settings` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pos_terminal_profiles_name` ON `pos_terminal_profiles` (`name`);--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `profile_id` text;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `profile_overrides` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `device_settings` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_pairing_codes` ADD `profile_id` text;
CREATE TABLE `kiosk_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`location_name` text DEFAULT '' NOT NULL,
	`tz` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`last_seen_at` integer,
	`failed_pin_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`revoked_at` integer,
	`revoked_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kiosk_devices_token_hash_unique` ON `kiosk_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_kiosk_devices_location` ON `kiosk_devices` (`location_id`);--> statement-breakpoint
CREATE TABLE `kiosk_pairing_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`location_name` text DEFAULT '' NOT NULL,
	`tz` text NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`device_id` text
);
--> statement-breakpoint
CREATE TABLE `time_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`location_id` text NOT NULL,
	`position_id` text,
	`shift_id` text,
	`clock_in_at` integer NOT NULL,
	`clock_out_at` integer,
	`tz` text NOT NULL,
	`local_date` text NOT NULL,
	`source` text NOT NULL,
	`device_id` text,
	`unpaid_break_min` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`approved_at` integer,
	`approved_by` text,
	`deleted_at` integer,
	`client_request_id` text,
	`clock_out_request_id` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`position_id`) REFERENCES `staff_positions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `time_entries_client_request_unique` ON `time_entries` (`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `time_entries_clock_out_request_unique` ON `time_entries` (`clock_out_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `time_entries_one_open_per_staff` ON `time_entries` (`staff_id`) WHERE clock_out_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_time_entries_location_date` ON `time_entries` (`location_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `idx_time_entries_staff_in` ON `time_entries` (`staff_id`,`clock_in_at`);--> statement-breakpoint
CREATE TABLE `time_entry_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_ref` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`reason` text,
	`at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `time_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_time_entry_events_entry` ON `time_entry_events` (`entry_id`,`at`);--> statement-breakpoint
ALTER TABLE `staff_members` ADD `pin_hash` text;--> statement-breakpoint
ALTER TABLE `staff_members` ADD `pin_set_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `staff_members_pin_hash_unique` ON `staff_members` (`pin_hash`);
ALTER TABLE `pos_devices` ADD `timeclock_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `reservations_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `timeclock_disabled_at` integer;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `location_bound_at` integer;--> statement-breakpoint
ALTER TABLE `pos_pairing_codes` ADD `timeclock_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_pairing_codes` ADD `reservations_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE `pos_hosts` (
	`staff_id` text PRIMARY KEY NOT NULL,
	`guest_details` integer DEFAULT false NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `kds_location_settings` (
	`location_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`config` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `kds_tickets` (
	`source` text NOT NULL,
	`order_id` text NOT NULL,
	`location_id` text NOT NULL,
	`version` integer NOT NULL,
	`progress` text NOT NULL,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`source`, `order_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_kds_tickets_location_done` ON `kds_tickets` (`location_id`, `completed_at`);
--> statement-breakpoint
CREATE TABLE `kds_events` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`device_id` text NOT NULL,
	`staff_id` text,
	`source` text,
	`order_id` text,
	`action` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `kds_events_no_update` BEFORE UPDATE ON `kds_events`
BEGIN SELECT RAISE(ABORT, 'Kitchen history is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `kds_events_no_delete` BEFORE DELETE ON `kds_events`
BEGIN SELECT RAISE(ABORT, 'Kitchen history is append-only'); END;

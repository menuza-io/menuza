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

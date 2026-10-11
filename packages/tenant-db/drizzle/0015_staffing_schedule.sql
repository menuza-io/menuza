CREATE TABLE `schedule_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`week_start` text NOT NULL,
	`published_by` text NOT NULL,
	`shift_count` integer NOT NULL,
	`changed_count` integer NOT NULL,
	`notified_count` integer DEFAULT 0 NOT NULL,
	`not_notified_count` integer DEFAULT 0 NOT NULL,
	`published_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_schedule_publications_week` ON `schedule_publications` (`location_id`,`week_start`,`published_at`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`staff_id` text,
	`position_id` text,
	`local_date` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`tz` text NOT NULL,
	`unpaid_break_min` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`published` text,
	`published_at` integer,
	`deleted_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`position_id`) REFERENCES `staff_positions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_shifts_location_date` ON `shifts` (`location_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `idx_shifts_staff_start` ON `shifts` (`staff_id`,`start_at`);
CREATE TABLE `staff_assignments` (
	`staff_id` text NOT NULL,
	`location_id` text NOT NULL,
	`position_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`staff_id`, `location_id`, `position_id`),
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`position_id`) REFERENCES `staff_positions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_staff_assignments_location` ON `staff_assignments` (`location_id`);--> statement-breakpoint
CREATE INDEX `idx_staff_assignments_position` ON `staff_assignments` (`position_id`);--> statement-breakpoint
CREATE TABLE `staff_events` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text,
	`kind` text NOT NULL,
	`actor_ref` text NOT NULL,
	`detail` text,
	`at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_staff_events_staff` ON `staff_events` (`staff_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_staff_events_at` ON `staff_events` (`at`);--> statement-breakpoint
CREATE TABLE `staff_members` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`first_name` text NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`email` text,
	`phone` text,
	`status` text DEFAULT 'active' NOT NULL,
	`hired_on` text,
	`terminated_on` text,
	`termination_reason` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_staff_members_status` ON `staff_members` (`status`,`last_name`);--> statement-breakpoint
CREATE INDEX `idx_staff_members_email` ON `staff_members` (`email`);--> statement-breakpoint
CREATE TABLE `staff_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color_key` text DEFAULT 'gray' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `staff_positions_name_unique` ON `staff_positions` (lower("name"));--> statement-breakpoint
CREATE TABLE `staffing_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`week_start` text DEFAULT 'monday' NOT NULL,
	`weekly_hours_threshold` real DEFAULT 40,
	`late_grace_minutes` integer DEFAULT 5 NOT NULL,
	`updated_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);

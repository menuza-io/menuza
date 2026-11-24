CREATE TABLE `staff_announcement_reads` (
	`announcement_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`source` text DEFAULT 'schedule' NOT NULL,
	`read_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`announcement_id`, `staff_id`),
	FOREIGN KEY (`announcement_id`) REFERENCES `staff_announcements`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_staff_announcement_reads_staff` ON `staff_announcement_reads` (`staff_id`);--> statement-breakpoint
CREATE TABLE `staff_announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`audience` text DEFAULT 'everyone' NOT NULL,
	`audience_id` text,
	`starts_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`withdrawn_at` integer,
	`withdrawn_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_staff_announcements_expires` ON `staff_announcements` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_staff_announcements_audience` ON `staff_announcements` (`audience`,`audience_id`);--> statement-breakpoint
CREATE TABLE `staff_hour_limits` (
	`staff_id` text PRIMARY KEY NOT NULL,
	`daily_cap_minutes` integer,
	`weekly_cap_minutes` integer,
	`follows_ramadan` integer DEFAULT false NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `time_correction_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `time_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_time_correction_open_entry` ON `time_correction_requests` (`entry_id`) WHERE "time_correction_requests"."status" = 'open';--> statement-breakpoint
CREATE INDEX `idx_time_correction_staff` ON `time_correction_requests` (`staff_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `labor_policies` ADD `hour_cap_daily_minutes` integer;--> statement-breakpoint
ALTER TABLE `labor_policies` ADD `hour_cap_weekly_minutes` integer;--> statement-breakpoint
ALTER TABLE `labor_policies` ADD `hour_cap_ramadan_daily_minutes` integer;--> statement-breakpoint
ALTER TABLE `labor_policies` ADD `hour_cap_ramadan_weekly_minutes` integer;--> statement-breakpoint
ALTER TABLE `schedule_settings` ADD `show_staff_pay_estimate` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shift_requests` ADD `applied_publication_id` text;
CREATE TABLE `inv_count_devices` (
	`count_id` text NOT NULL,
	`device_id` text NOT NULL,
	`device_kind` text DEFAULT 'station' NOT NULL,
	`device_name` text,
	`person_kind` text NOT NULL,
	`person_id` text,
	`joined_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`last_sync_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`unsent_count` integer,
	`done_at` integer,
	PRIMARY KEY(`count_id`, `device_id`),
	FOREIGN KEY (`count_id`) REFERENCES `inv_counts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_inv_count_devices_count` ON `inv_count_devices` (`count_id`);--> statement-breakpoint
CREATE TABLE `inv_count_late_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`count_id` text NOT NULL,
	`item_id` text NOT NULL,
	`area_id` text,
	`quantity` integer NOT NULL,
	`entered_amount` text NOT NULL,
	`entered_unit` text NOT NULL,
	`counter_kind` text NOT NULL,
	`counter_id` text,
	`device_id` text,
	`client_id` text NOT NULL,
	`counted_at` integer NOT NULL,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_at` integer,
	`resolved_by_id` text,
	`movement_id` text,
	FOREIGN KEY (`count_id`) REFERENCES `inv_counts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_count_late_entries_status" CHECK("inv_count_late_entries"."status" in ('open', 'applied', 'dismissed')),
	CONSTRAINT "chk_inv_count_late_entries_quantity" CHECK("inv_count_late_entries"."quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_count_late_entries_client` ON `inv_count_late_entries` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_count_late_entries_count` ON `inv_count_late_entries` (`count_id`,`status`);--> statement-breakpoint
CREATE TABLE `inv_count_schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`location_id` text NOT NULL,
	`run_date` text NOT NULL,
	`due_at` integer NOT NULL,
	`kind` text NOT NULL,
	`list_id` text,
	`slot` text DEFAULT 'custom' NOT NULL,
	`assignee_kind` text,
	`assignee_id` text,
	`count_id` text,
	`status` text DEFAULT 'due' NOT NULL,
	`overdue_alerted_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `inv_count_schedules`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_count_schedule_runs_status" CHECK("inv_count_schedule_runs"."status" in ('due', 'started', 'not_finished'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_count_schedule_runs_day` ON `inv_count_schedule_runs` (`schedule_id`,`run_date`);--> statement-breakpoint
CREATE INDEX `idx_inv_count_schedule_runs_location` ON `inv_count_schedule_runs` (`location_id`,`run_date`);--> statement-breakpoint
CREATE TABLE `inv_count_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`kind` text NOT NULL,
	`list_id` text,
	`slot` text DEFAULT 'custom' NOT NULL,
	`time_local` text NOT NULL,
	`weekdays` text DEFAULT '[0,1,2,3,4,5,6]' NOT NULL,
	`assignee_kind` text,
	`assignee_id` text,
	`effective_from` text NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `inv_count_lists`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_count_schedules_kind" CHECK("inv_count_schedules"."kind" in ('full', 'quick')),
	CONSTRAINT "chk_inv_count_schedules_weekdays" CHECK(json_valid("inv_count_schedules"."weekdays"))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_count_schedules_location` ON `inv_count_schedules` (`location_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `inv_count_second_checks` (
	`count_id` text NOT NULL,
	`item_id` text NOT NULL,
	`first_quantity` integer,
	`second_quantity` integer,
	`second_counted_at` integer,
	`resolution` text,
	`resolved_by_id` text,
	`resolved_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`count_id`, `item_id`),
	FOREIGN KEY (`count_id`) REFERENCES `inv_counts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_count_second_checks_resolution" CHECK("inv_count_second_checks"."resolution" is null or "inv_count_second_checks"."resolution" in ('first', 'second'))
);
--> statement-breakpoint
ALTER TABLE `inv_count_entries` ADD `pass` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_counts` ADD `kind` text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_counts` ADD `schedule_run_id` text;--> statement-breakpoint
ALTER TABLE `inv_counts` ADD `second_state` text;--> statement-breakpoint
ALTER TABLE `inv_counts` ADD `second_started_at` integer;--> statement-breakpoint
ALTER TABLE `inv_counts` ADD `second_skip_reason` text;--> statement-breakpoint
ALTER TABLE `inv_counts` ADD `second_skipped_by` text;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `is_key` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `counted_by_bottle` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `bottle_size_ml` integer;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `full_bottle_weight_g` integer;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `empty_bottle_weight_g` integer;--> statement-breakpoint
ALTER TABLE `inv_location_settings` ADD `second_count_required` integer DEFAULT false NOT NULL;
CREATE TABLE `pos_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`built_in` integer DEFAULT false NOT NULL,
	`permissions` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pos_roles_name` ON `pos_roles` (`name`);--> statement-breakpoint
CREATE TABLE `qr_tab_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tab_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`tab_id`) REFERENCES `qr_tabs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_qr_tab_events_tab` ON `qr_tab_events` (`tab_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `inv_location_settings` ADD `few_left_threshold` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `terminal_kind` text DEFAULT 'till' NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `permission_allow` text;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `print_shift_on_close` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `print_clock_slip` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_pairing_codes` ADD `replaces_device_id` text;--> statement-breakpoint
ALTER TABLE `pos_shifts` ADD `auto_print_job_id` text;--> statement-breakpoint
ALTER TABLE `pos_shifts` ADD `auto_print_status` text;--> statement-breakpoint
ALTER TABLE `pos_shifts` ADD `auto_printed_at` integer;--> statement-breakpoint
ALTER TABLE `qr_settings` ADD `auto_close_hours` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `qr_settings` ADD `split_min_basket_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `qr_settings` ADD `split_max_parts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `qr_settings` ADD `split_require_payment_first` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `qr_tab_payments` ADD `split_index` integer;--> statement-breakpoint
ALTER TABLE `qr_tab_payments` ADD `split_status` text;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `last_round_at` integer;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `closed_by_actor` text;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `manager_flagged_at` integer;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `held_payment_ref` text;--> statement-breakpoint
ALTER TABLE `staff_members` ADD `pos_role_id` text;--> statement-breakpoint
ALTER TABLE `time_entries` ADD `slip_print_job_id` text;--> statement-breakpoint
ALTER TABLE `time_entries` ADD `slip_print_status` text;--> statement-breakpoint
ALTER TABLE `time_entries` ADD `slip_printed_at` integer;
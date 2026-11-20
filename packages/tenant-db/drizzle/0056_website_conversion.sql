CREATE TABLE `form_export_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_id` text DEFAULT '' NOT NULL,
	`operator_id` text NOT NULL,
	`row_count` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_form_export_audit_created` ON `form_export_audit` (`created_at`);--> statement-breakpoint
CREATE TABLE `form_response_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_form_response_outbox_due` ON `form_response_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `site_events_daily` (
	`date` text NOT NULL,
	`location_id` text DEFAULT '' NOT NULL,
	`event` text NOT NULL,
	`device` text NOT NULL,
	`entry` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`date`, `location_id`, `event`, `device`, `entry`, `variant`)
);
--> statement-breakpoint
ALTER TABLE `website_forms` ADD `notify` text;--> statement-breakpoint
ALTER TABLE `website_forms` ADD `restricted` integer DEFAULT false NOT NULL;
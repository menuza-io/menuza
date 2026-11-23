CREATE TABLE `inv_repeat_order_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`repeat_order_id` text NOT NULL,
	`delivery_date` text NOT NULL,
	`cutoff_date` text NOT NULL,
	`cutoff_time` text NOT NULL,
	`status` text NOT NULL,
	`order_id` text,
	`note` text,
	`alert_status` text DEFAULT 'sent' NOT NULL,
	`alert_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`repeat_order_id`) REFERENCES `inv_repeat_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `inv_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_repeat_order_runs_status" CHECK("inv_repeat_order_runs"."status" in ('skipped', 'skipped_holiday', 'drafted')),
	CONSTRAINT "chk_inv_repeat_order_runs_alert" CHECK("inv_repeat_order_runs"."alert_status" in ('pending', 'sent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_repeat_order_runs_date` ON `inv_repeat_order_runs` (`repeat_order_id`,`delivery_date`);--> statement-breakpoint
CREATE INDEX `idx_inv_repeat_order_runs_alert` ON `inv_repeat_order_runs` (`alert_status`,`created_at`);--> statement-breakpoint
CREATE TABLE `inv_repeat_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`location_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`source_order_id` text,
	`cadence_weeks` integer NOT NULL,
	`weekdays` text DEFAULT '[]' NOT NULL,
	`mode` text DEFAULT 'fixed_lines' NOT NULL,
	`anchor_date` text NOT NULL,
	`lines_json` text DEFAULT '[]' NOT NULL,
	`note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `inv_suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_order_id`) REFERENCES `inv_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_repeat_orders_cadence" CHECK("inv_repeat_orders"."cadence_weeks" in (1, 2, 4)),
	CONSTRAINT "chk_inv_repeat_orders_weekdays" CHECK(json_valid("inv_repeat_orders"."weekdays")),
	CONSTRAINT "chk_inv_repeat_orders_mode" CHECK("inv_repeat_orders"."mode" in ('fixed_lines', 'top_up')),
	CONSTRAINT "chk_inv_repeat_orders_lines" CHECK(json_valid("inv_repeat_orders"."lines_json")),
	CONSTRAINT "chk_inv_repeat_orders_status" CHECK("inv_repeat_orders"."status" in ('active', 'paused', 'cancelled')),
	CONSTRAINT "chk_inv_repeat_orders_actor" CHECK("inv_repeat_orders"."created_by_kind" in ('operator', 'staff', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_repeat_orders_client` ON `inv_repeat_orders` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_repeat_orders_location_status` ON `inv_repeat_orders` (`location_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_inv_repeat_orders_supplier` ON `inv_repeat_orders` (`supplier_id`);--> statement-breakpoint
ALTER TABLE `inv_location_settings` ADD `special_hours` text;--> statement-breakpoint
ALTER TABLE `inv_location_settings` ADD `order_limit_minor` integer;--> statement-breakpoint
ALTER TABLE `inv_location_settings` ADD `monthly_limit_minor` integer;--> statement-breakpoint
ALTER TABLE `inv_order_lines` ADD `suggestion_explanation_json` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `repeat_order_id` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approval_status` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `requested_send_channel` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `requested_send_locale` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approval_requested_at` integer;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approval_requested_by_kind` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approval_requested_by_id` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approval_breached_order_limit` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approval_breached_monthly_limit` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approved_at` integer;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approved_by_kind` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approved_by_id` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `rejected_at` integer;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `rejected_by_kind` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `rejected_by_id` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `rejection_reason` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approval_alert_status` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `approval_alert_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_inv_orders_approval` ON `inv_orders` (`location_id`,`approval_status`);--> statement-breakpoint
ALTER TABLE `inv_suppliers` ADD `paused_at` integer;
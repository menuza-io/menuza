CREATE TABLE `qr_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`require_guest_name` integer DEFAULT false NOT NULL,
	`require_guest_phone` integer DEFAULT false NOT NULL,
	`allow_online_tab_pay` integer DEFAULT true NOT NULL,
	`per_table_limit_per_hour` integer DEFAULT 12 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `qr_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`label` text NOT NULL,
	`token_version` integer DEFAULT 1 NOT NULL,
	`imported_rsv_table_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qr_tables_location_label_live` ON `qr_tables` (`location_id`,`label`) WHERE "qr_tables"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `qr_tables_imported_rsv_live` ON `qr_tables` (`imported_rsv_table_id`) WHERE "qr_tables"."imported_rsv_table_id" is not null and "qr_tables"."archived_at" is null;--> statement-breakpoint
CREATE INDEX `idx_qr_tables_location` ON `qr_tables` (`location_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `qr_tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`table_id` text NOT NULL,
	`location_id` text NOT NULL,
	`table_label` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`tab_number` text NOT NULL,
	`opened_day` text NOT NULL,
	`tab_token_version` integer DEFAULT 1 NOT NULL,
	`guest_name` text,
	`guest_phone` text,
	`currency` text NOT NULL,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`tip_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`payment_method` text,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`payment_processor` text,
	`payment_session_id` text,
	`payment_token_hash` text,
	`payment_amount_cents` integer,
	`payment_tip_cents` integer,
	`payment_event_at` integer,
	`void_reason` text,
	`locked_at` integer,
	`closed_by` text,
	`version` integer DEFAULT 1 NOT NULL,
	`opened_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`closed_at` integer,
	`paid_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`table_id`) REFERENCES `qr_tables`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qr_tabs_one_open_per_table` ON `qr_tabs` (`table_id`) WHERE "qr_tabs"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX `qr_tabs_day_number` ON `qr_tabs` (`opened_day`,`tab_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `qr_tabs_payment_session_unique` ON `qr_tabs` (`payment_session_id`);--> statement-breakpoint
CREATE INDEX `idx_qr_tabs_status_opened` ON `qr_tabs` (`status`,`opened_at`);--> statement-breakpoint
CREATE INDEX `idx_qr_tabs_location_status` ON `qr_tabs` (`location_id`,`status`);--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `tab_id` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `table_id` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `table_label` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `source` text;--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_tab` ON `restaurant_orders` (`tab_id`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_table_created` ON `restaurant_orders` (`table_id`,`created_at`);
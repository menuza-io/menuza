CREATE TABLE `inv_invoice_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`source` text NOT NULL,
	`message_id` text,
	`from_address` text,
	`subject` text,
	`body_key` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`sender_state` text DEFAULT 'known' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`read_state` text DEFAULT 'not_configured' NOT NULL,
	`supplier_id` text,
	`supplier_name` text,
	`invoice_number` text,
	`invoice_date` text,
	`total_minor` integer,
	`currency` text,
	`lines_json` text,
	`duplicate_of_id` text,
	`order_id` text,
	`delivery_id` text,
	`added_by_kind` text,
	`added_by_id` text,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `inv_suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `inv_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivery_id`) REFERENCES `inv_deliveries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_invoice_inbox_source" CHECK("inv_invoice_inbox"."source" in ('email', 'upload', 'station')),
	CONSTRAINT "chk_inv_invoice_inbox_status" CHECK("inv_invoice_inbox"."status" in ('new', 'matched', 'delivered', 'dismissed')),
	CONSTRAINT "chk_inv_invoice_inbox_sender" CHECK("inv_invoice_inbox"."sender_state" in ('known', 'allowed', 'unknown')),
	CONSTRAINT "chk_inv_invoice_inbox_read" CHECK("inv_invoice_inbox"."read_state" in ('pending', 'read', 'failed', 'not_configured'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_invoice_inbox_message` ON `inv_invoice_inbox` (`location_id`,`message_id`) WHERE "inv_invoice_inbox"."message_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inv_invoice_inbox_location` ON `inv_invoice_inbox` (`location_id`,`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_invoice_inbox_number` ON `inv_invoice_inbox` (`supplier_id`,`invoice_number`);--> statement-breakpoint
CREATE TABLE `inv_invoice_inbox_files` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`file_name` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`inbox_id`) REFERENCES `inv_invoice_inbox`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_inv_invoice_inbox_files_inbox` ON `inv_invoice_inbox_files` (`inbox_id`,`position`);--> statement-breakpoint
CREATE TABLE `inv_invoice_senders` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`supplier_id` text,
	`allowed_by_kind` text NOT NULL,
	`allowed_by_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `inv_suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_invoice_senders_address` ON `inv_invoice_senders` (`address`);--> statement-breakpoint
CREATE TABLE `inv_lot_takes` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`reason` text NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`lot_id`) REFERENCES `inv_stock_lots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_lot_takes_quantity" CHECK("inv_lot_takes"."quantity" > 0),
	CONSTRAINT "chk_inv_lot_takes_reason" CHECK("inv_lot_takes"."reason" in ('expired_waste', 'delivery_cancel'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_lot_takes_source` ON `inv_lot_takes` (`lot_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_lot_takes_lot` ON `inv_lot_takes` (`lot_id`);--> statement-breakpoint
CREATE TABLE `inv_routine_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`location_id` text NOT NULL,
	`key` text NOT NULL,
	`run_key` text NOT NULL,
	`status` text NOT NULL,
	`summary_json` text DEFAULT '{}' NOT NULL,
	`alert_status` text DEFAULT 'sent' NOT NULL,
	`alert_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`routine_id`) REFERENCES `inv_routines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_routine_runs_status" CHECK("inv_routine_runs"."status" in ('done', 'nothing_to_do', 'failed')),
	CONSTRAINT "chk_inv_routine_runs_summary" CHECK(json_valid("inv_routine_runs"."summary_json"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_routine_runs_key` ON `inv_routine_runs` (`location_id`,`key`,`run_key`);--> statement-breakpoint
CREATE INDEX `idx_inv_routine_runs_routine` ON `inv_routine_runs` (`routine_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_routine_runs_alert` ON `inv_routine_runs` (`alert_status`,`created_at`);--> statement-breakpoint
CREATE TABLE `inv_routines` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`key` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`enabled_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_routines_key" CHECK("inv_routines"."key" in ('count_low_stock', 'weekly_waste', 'morning_brief', 'supplier_cutoff'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_routines_location_key` ON `inv_routines` (`location_id`,`key`);--> statement-breakpoint
CREATE TABLE `inv_stock_lots` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`item_id` text NOT NULL,
	`use_by_date` text NOT NULL,
	`quantity` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`baseline` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_stock_lots_quantity" CHECK("inv_stock_lots"."quantity" > 0),
	CONSTRAINT "chk_inv_stock_lots_source" CHECK("inv_stock_lots"."source_type" in ('delivery', 'batch', 'confirm')),
	CONSTRAINT "chk_inv_stock_lots_date" CHECK("inv_stock_lots"."use_by_date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_stock_lots_source` ON `inv_stock_lots` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_stock_lots_item` ON `inv_stock_lots` (`location_id`,`item_id`,`use_by_date`);--> statement-breakpoint
ALTER TABLE `inv_count_entries` ADD `transcript` text;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `track_by_date` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `shelf_life_hours` integer;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `storage_note` text;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `name_ar` text;
--> statement-breakpoint
-- Lots and takes are append-only, like the ledger they sit beside (#479).
CREATE TRIGGER `inv_stock_lots_no_update` BEFORE UPDATE ON `inv_stock_lots`
BEGIN SELECT RAISE(ABORT, 'inv_stock_lots is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_stock_lots_no_delete` BEFORE DELETE ON `inv_stock_lots`
BEGIN SELECT RAISE(ABORT, 'inv_stock_lots is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_lot_takes_no_update` BEFORE UPDATE ON `inv_lot_takes`
BEGIN SELECT RAISE(ABORT, 'inv_lot_takes is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_lot_takes_no_delete` BEFORE DELETE ON `inv_lot_takes`
BEGIN SELECT RAISE(ABORT, 'inv_lot_takes is append-only'); END;
--> statement-breakpoint
-- A take never exceeds its lot's own quantity (all takes together).
CREATE TRIGGER `inv_lot_takes_within_lot` BEFORE INSERT ON `inv_lot_takes`
WHEN NEW.quantity > (SELECT quantity FROM `inv_stock_lots` WHERE id = NEW.lot_id)
	- COALESCE((SELECT SUM(quantity) FROM `inv_lot_takes` WHERE lot_id = NEW.lot_id), 0)
BEGIN SELECT RAISE(ABORT, 'inv_lot_takes exceeds the lot'); END;
--> statement-breakpoint
-- Routine runs are a record of what happened: never removed or rewritten,
-- except the alert bookkeeping the tick updates.
CREATE TRIGGER `inv_routine_runs_no_delete` BEFORE DELETE ON `inv_routine_runs`
BEGIN SELECT RAISE(ABORT, 'inv_routine_runs is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_routine_runs_no_rewrite` BEFORE UPDATE ON `inv_routine_runs`
WHEN NEW.id IS NOT OLD.id
	OR NEW.routine_id IS NOT OLD.routine_id
	OR NEW.location_id IS NOT OLD.location_id
	OR NEW.key IS NOT OLD.key
	OR NEW.run_key IS NOT OLD.run_key
	OR NEW.status IS NOT OLD.status
	OR NEW.summary_json IS NOT OLD.summary_json
BEGIN SELECT RAISE(ABORT, 'inv_routine_runs is append-only'); END;

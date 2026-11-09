CREATE TABLE `inv_cost_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`delivery_line_id` text,
	`location_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`cost_micro` integer NOT NULL,
	`on_hand_before` integer NOT NULL,
	`avg_before_micro` integer,
	`avg_after_micro` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivery_line_id`) REFERENCES `inv_delivery_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_cost_events_kind" CHECK("inv_cost_events"."kind" in ('delivery', 'confirm', 'batch')),
	CONSTRAINT "chk_inv_cost_events_amounts" CHECK("inv_cost_events"."quantity" >= 0 and "inv_cost_events"."cost_micro" >= 0 and "inv_cost_events"."avg_after_micro" >= 0 and ("inv_cost_events"."avg_before_micro" is null or "inv_cost_events"."avg_before_micro" >= 0))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_cost_events_item` ON `inv_cost_events` (`item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_cost_events_line` ON `inv_cost_events` (`delivery_line_id`);--> statement-breakpoint
CREATE TABLE `inv_location_settings` (
	`location_id` text PRIMARY KEY NOT NULL,
	`currency` text,
	`currency_source` text,
	`time_zone` text,
	`day_start_minutes` integer DEFAULT 240 NOT NULL,
	`prices_include_tax` integer DEFAULT false NOT NULL,
	`tax_rate_bp` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`synced_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_location_settings_day_start" CHECK("inv_location_settings"."day_start_minutes" between 0 and 1439),
	CONSTRAINT "chk_inv_location_settings_tax" CHECK("inv_location_settings"."tax_rate_bp" is null or "inv_location_settings"."tax_rate_bp" between 0 and 10000),
	CONSTRAINT "chk_inv_location_settings_source" CHECK("inv_location_settings"."currency_source" is null or "inv_location_settings"."currency_source" in ('app', 'delivery'))
);
--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `client_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_deliveries_client` ON `inv_deliveries` (`location_id`,`client_id`);--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `send_claim_at` integer;--> statement-breakpoint
ALTER TABLE `inv_settings` ADD `count_time` text;--> statement-breakpoint
-- The steps of an item's average cost are history: never changed or removed.
CREATE TRIGGER `inv_cost_events_no_update` BEFORE UPDATE ON `inv_cost_events`
BEGIN SELECT RAISE(ABORT, 'inv_cost_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_cost_events_no_delete` BEFORE DELETE ON `inv_cost_events`
BEGIN SELECT RAISE(ABORT, 'inv_cost_events is append-only'); END;

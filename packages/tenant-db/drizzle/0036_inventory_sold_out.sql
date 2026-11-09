CREATE TABLE `inv_sold_out` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`cause_item_id` text NOT NULL,
	`state` text DEFAULT 'out' NOT NULL,
	`sold_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`undone_at` integer,
	`undone_by_kind` text,
	`undone_by_id` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`cause_item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_sold_out_entity_type" CHECK("inv_sold_out"."entity_type" in ('item', 'modifier_option')),
	CONSTRAINT "chk_inv_sold_out_state" CHECK("inv_sold_out"."state" in ('out', 'undone'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_sold_out_entity` ON `inv_sold_out` (`location_id`,`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_sold_out_cause` ON `inv_sold_out` (`cause_item_id`);
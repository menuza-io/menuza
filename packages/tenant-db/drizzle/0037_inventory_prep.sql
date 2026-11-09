CREATE TABLE `inv_prep_items` (
	`item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`station_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`item_id`, `location_id`),
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `inv_prep_levels` (
	`item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`fill_up_to_quantity` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`item_id`, `location_id`, `weekday`),
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_prep_levels_weekday" CHECK("inv_prep_levels"."weekday" between 0 and 6),
	CONSTRAINT "chk_inv_prep_levels_quantity" CHECK("inv_prep_levels"."fill_up_to_quantity" between 0 and 9000000000)
);
--> statement-breakpoint
CREATE TABLE `inv_prep_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`business_date` text NOT NULL,
	`item_id` text NOT NULL,
	`station_id` text,
	`planned_quantity` integer NOT NULL,
	`fill_up_to_quantity` integer NOT NULL,
	`on_hand_quantity` integer NOT NULL,
	`demand_bp` integer DEFAULT 10000 NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`started_at` integer,
	`started_by_kind` text,
	`started_by_id` text,
	`done_at` integer,
	`done_by_kind` text,
	`done_by_id` text,
	`made_quantity` integer,
	`batch_source_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_prep_tasks_status" CHECK("inv_prep_tasks"."status" in ('todo', 'in_progress', 'done', 'skipped')),
	CONSTRAINT "chk_inv_prep_tasks_quantities" CHECK("inv_prep_tasks"."planned_quantity" >= 0 and "inv_prep_tasks"."fill_up_to_quantity" >= 0 and ("inv_prep_tasks"."made_quantity" is null or "inv_prep_tasks"."made_quantity" >= 0)),
	CONSTRAINT "chk_inv_prep_tasks_done" CHECK("inv_prep_tasks"."status" <> 'done' or ("inv_prep_tasks"."done_at" is not null and "inv_prep_tasks"."made_quantity" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_prep_tasks_day_item` ON `inv_prep_tasks` (`location_id`,`business_date`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_prep_tasks_day` ON `inv_prep_tasks` (`location_id`,`business_date`,`status`);
CREATE TABLE `delivery_driver_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`kind` text NOT NULL,
	`run_id` text,
	`order_numbers` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_delivery_notices_kind" CHECK("delivery_driver_notices"."kind" in ('assigned', 'taken_away', 'stop_released'))
);
--> statement-breakpoint
CREATE INDEX `idx_delivery_notices_staff` ON `delivery_driver_notices` (`staff_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `delivery_driver_status` (
	`staff_id` text PRIMARY KEY NOT NULL,
	`unavailable` integer DEFAULT false NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `delivery_run_positions` (
	`run_id` text PRIMARY KEY NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `delivery_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `delivery_run_stops` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`order_id` text NOT NULL,
	`stop_no` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`cash_due_cents` integer DEFAULT 0 NOT NULL,
	`cash_collected_cents` integer DEFAULT 0 NOT NULL,
	`zone_id` text,
	`problem_kind` text,
	`delivered_by_kind` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`picked_up_at` integer,
	`delivered_at` integer,
	`problem_at` integer,
	`released_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `delivery_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_delivery_stops_status" CHECK("delivery_run_stops"."status" in ('pending', 'picked_up', 'delivered', 'problem', 'released')),
	CONSTRAINT "chk_delivery_stops_problem" CHECK("delivery_run_stops"."problem_kind" is null or "delivery_run_stops"."problem_kind" in ('not_home', 'wrong_address', 'refused', 'cannot_reach', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_delivery_stops_active_order` ON `delivery_run_stops` (`order_id`) WHERE "delivery_run_stops"."status" in ('pending', 'picked_up', 'problem');--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_delivery_stops_run_no` ON `delivery_run_stops` (`run_id`,`stop_no`);--> statement-breakpoint
CREATE INDEX `idx_delivery_stops_run` ON `delivery_run_stops` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_delivery_stops_order` ON `delivery_run_stops` (`order_id`);--> statement-breakpoint
CREATE TABLE `delivery_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`driver_staff_id` text NOT NULL,
	`status` text DEFAULT 'assigned' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`picked_up_at` integer,
	`completed_at` integer,
	`cancelled_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`driver_staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_delivery_runs_status" CHECK("delivery_runs"."status" in ('assigned', 'on_the_road', 'completed', 'cancelled')),
	CONSTRAINT "chk_delivery_runs_actor" CHECK("delivery_runs"."created_by_kind" in ('manager', 'driver'))
);
--> statement-breakpoint
CREATE INDEX `idx_delivery_runs_driver` ON `delivery_runs` (`driver_staff_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_delivery_runs_location` ON `delivery_runs` (`location_id`,`status`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_order_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`dedupe_key` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_order_messages_kind" CHECK("__new_order_messages"."kind" in ('receipt', 'accepted', 'ready', 'out_for_delivery', 'cancelled', 'eta_changed', 'delivered')),
	CONSTRAINT "chk_order_messages_channel" CHECK("__new_order_messages"."channel" in ('email', 'sms')),
	CONSTRAINT "chk_order_messages_status" CHECK("__new_order_messages"."status" in ('queued', 'sent', 'failed', 'dropped'))
);
--> statement-breakpoint
INSERT INTO `__new_order_messages`("id", "order_id", "kind", "channel", "dedupe_key", "status", "attempts", "next_attempt_at", "last_error", "created_at", "sent_at") SELECT "id", "order_id", "kind", "channel", "dedupe_key", "status", "attempts", "next_attempt_at", "last_error", "created_at", "sent_at" FROM `order_messages`;--> statement-breakpoint
DROP TABLE `order_messages`;--> statement-breakpoint
ALTER TABLE `__new_order_messages` RENAME TO `order_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `order_messages_order_kind_channel_key_unique` ON `order_messages` (`order_id`,`kind`,`channel`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_order_messages_due` ON `order_messages` (`status`,`next_attempt_at`);--> statement-breakpoint
ALTER TABLE `staff_positions` ADD `delivers_orders` integer DEFAULT false NOT NULL;
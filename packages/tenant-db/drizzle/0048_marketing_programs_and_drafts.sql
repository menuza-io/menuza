CREATE TABLE `customer_carts` (
	`customer_id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`currency` text NOT NULL,
	`subtotal_cents` integer NOT NULL,
	`items` text NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`reminded_at` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_customer_carts_updated` ON `customer_carts` (`updated_at`);--> statement-breakpoint
CREATE TABLE `marketing_audiences` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`definition` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`system_key` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_marketing_audiences_name` ON `marketing_audiences` (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_marketing_audiences_system_key` ON `marketing_audiences` (`system_key`) WHERE "marketing_audiences"."system_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `marketing_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_journey_emissions` (
	`customer_id` text NOT NULL,
	`trigger` text NOT NULL,
	`ref` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`emitted_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`customer_id`, `trigger`, `ref`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_order_journey_emissions_trigger` ON `order_journey_emissions` (`trigger`,`emitted_at`);--> statement-breakpoint
ALTER TABLE `customers` ADD `birth_month_day` text;--> statement-breakpoint
ALTER TABLE `customers` ADD `birth_month_day_set_at` integer;--> statement-breakpoint
ALTER TABLE `marketing_journeys` ADD `goal` text;--> statement-breakpoint
ALTER TABLE `marketing_journeys` ADD `program_id` text;--> statement-breakpoint
ALTER TABLE `marketing_journeys` ADD `program_version` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_marketing_journeys_program` ON `marketing_journeys` (`program_id`) WHERE "marketing_journeys"."program_id" IS NOT NULL AND "marketing_journeys"."status" <> 'archived';
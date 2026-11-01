CREATE TABLE `discount_code_attempts` (
	`bucket` text NOT NULL,
	`subject_hash` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`bucket`, `subject_hash`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `idx_discount_code_attempts_window` ON `discount_code_attempts` (`window_start`);--> statement-breakpoint
CREATE TABLE `discount_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`discount_version` integer NOT NULL,
	`code_id` text,
	`normalized_code` text,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`customer_id` text,
	`state` text DEFAULT 'reserved' NOT NULL,
	`amount_minor` integer NOT NULL,
	`delivery_amount_minor` integer DEFAULT 0 NOT NULL,
	`allocation` text NOT NULL,
	`snapshot` text NOT NULL,
	`local_day` text NOT NULL,
	`local_week` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_discount_redemptions_state" CHECK("discount_redemptions"."state" in ('reserved', 'consumed', 'released', 'refunded')),
	CONSTRAINT "chk_discount_redemptions_amounts" CHECK("discount_redemptions"."amount_minor" >= 0 and "discount_redemptions"."delivery_amount_minor" >= 0),
	CONSTRAINT "chk_discount_redemptions_source_type" CHECK("discount_redemptions"."source_type" in ('order', 'tab', 'pos')),
	CONSTRAINT "chk_discount_redemptions_json" CHECK(json_valid("discount_redemptions"."allocation") and json_valid("discount_redemptions"."snapshot"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discount_redemptions_one_per_source` ON `discount_redemptions` (`source_type`,`source_id`,`discount_id`);--> statement-breakpoint
CREATE INDEX `idx_discount_redemptions_discount_state` ON `discount_redemptions` (`discount_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_discount_redemptions_discount_customer_state` ON `discount_redemptions` (`discount_id`,`customer_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_discount_redemptions_code_state` ON `discount_redemptions` (`code_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_discount_redemptions_source` ON `discount_redemptions` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_discount_redemptions_customer` ON `discount_redemptions` (`customer_id`);--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `discount_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `delivery_discount_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `discounts` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `discount_redemptions_no_delete` BEFORE DELETE ON `discount_redemptions`
BEGIN SELECT RAISE(ABORT, 'discount_redemptions rows are kept'); END;
--> statement-breakpoint
CREATE TRIGGER `discount_redemptions_born_reserved` BEFORE INSERT ON `discount_redemptions`
WHEN NEW.state <> 'reserved'
BEGIN SELECT RAISE(ABORT, 'discount_redemptions start reserved'); END;
--> statement-breakpoint
CREATE TRIGGER `discount_redemptions_transition` BEFORE UPDATE OF `state` ON `discount_redemptions`
WHEN NEW.state IS NOT OLD.state AND NOT (
	(OLD.state = 'reserved' AND NEW.state IN ('consumed', 'released'))
	OR (OLD.state = 'consumed' AND NEW.state = 'refunded')
)
BEGIN SELECT RAISE(ABORT, 'discount_redemptions transition not allowed'); END;
--> statement-breakpoint
CREATE TRIGGER `discount_redemptions_fixed` BEFORE UPDATE ON `discount_redemptions`
WHEN NEW.id IS NOT OLD.id
	OR NEW.discount_id IS NOT OLD.discount_id
	OR NEW.discount_version IS NOT OLD.discount_version
	OR NEW.code_id IS NOT OLD.code_id
	OR NEW.normalized_code IS NOT OLD.normalized_code
	OR NEW.source_type IS NOT OLD.source_type
	OR NEW.source_id IS NOT OLD.source_id
	OR NEW.amount_minor IS NOT OLD.amount_minor
	OR NEW.delivery_amount_minor IS NOT OLD.delivery_amount_minor
	OR NEW.allocation IS NOT OLD.allocation
	OR NEW.snapshot IS NOT OLD.snapshot
	OR NEW.local_day IS NOT OLD.local_day
	OR NEW.local_week IS NOT OLD.local_week
	OR NEW.created_at IS NOT OLD.created_at
	OR (NEW.customer_id IS NOT OLD.customer_id AND NEW.customer_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'discount_redemptions facts are fixed'); END;

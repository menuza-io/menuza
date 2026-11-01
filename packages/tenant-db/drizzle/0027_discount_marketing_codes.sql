CREATE TABLE `discount_issued_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`code` text NOT NULL,
	`normalized_code` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`customer_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_discount_issued_codes_source_type" CHECK("discount_issued_codes"."source_type" in ('campaign', 'journey'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `discount_issued_codes_normalized` ON `discount_issued_codes` (`normalized_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `discount_issued_codes_one_per_recipient` ON `discount_issued_codes` (`source_type`,`source_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_discount_issued_codes_discount` ON `discount_issued_codes` (`discount_id`);--> statement-breakpoint
CREATE INDEX `idx_discount_issued_codes_customer` ON `discount_issued_codes` (`customer_id`);--> statement-breakpoint
ALTER TABLE `marketing_campaigns` ADD `discount_offer` text;--> statement-breakpoint
CREATE TRIGGER `discount_issued_codes_fixed` BEFORE UPDATE ON `discount_issued_codes`
WHEN NEW.id IS NOT OLD.id
	OR NEW.discount_id IS NOT OLD.discount_id
	OR NEW.code IS NOT OLD.code
	OR NEW.normalized_code IS NOT OLD.normalized_code
	OR NEW.source_type IS NOT OLD.source_type
	OR NEW.source_id IS NOT OLD.source_id
	OR NEW.expires_at IS NOT OLD.expires_at
	OR NEW.created_at IS NOT OLD.created_at
	OR (NEW.customer_id IS NOT OLD.customer_id AND NEW.customer_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'discount_issued_codes rows only lose their customer'); END;

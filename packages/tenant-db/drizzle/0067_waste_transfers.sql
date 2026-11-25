CREATE TABLE `inv_transfer_terms` (
	`item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`branch_requestable` integer DEFAULT true NOT NULL,
	`price_mode` text DEFAULT 'none' NOT NULL,
	`fixed_price_micro` integer,
	`currency` text,
	`markup_bp` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`item_id`, `location_id`),
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_transfer_terms_mode" CHECK("inv_transfer_terms"."price_mode" in ('none', 'fixed', 'cost_plus')),
	CONSTRAINT "chk_inv_transfer_terms_price" CHECK(("inv_transfer_terms"."fixed_price_micro" is null or "inv_transfer_terms"."fixed_price_micro" >= 0) and ("inv_transfer_terms"."markup_bp" is null or ("inv_transfer_terms"."markup_bp" >= 0 and "inv_transfer_terms"."markup_bp" <= 100000)) and ("inv_transfer_terms"."price_mode" <> 'fixed' or ("inv_transfer_terms"."fixed_price_micro" is not null and "inv_transfer_terms"."currency" is not null)) and ("inv_transfer_terms"."price_mode" <> 'cost_plus' or "inv_transfer_terms"."markup_bp" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_transfer_terms_location` ON `inv_transfer_terms` (`location_id`);--> statement-breakpoint
CREATE TABLE `inv_waste_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`waste_id` text NOT NULL,
	`group_id` text,
	`kind` text NOT NULL,
	`previous_quantity` integer NOT NULL,
	`new_quantity` integer NOT NULL,
	`value_delta_minor` integer,
	`currency` text,
	`stock_effect` text NOT NULL,
	`reason` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`business_date` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`waste_id`) REFERENCES `inv_waste`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_waste_corrections_kind" CHECK("inv_waste_corrections"."kind" in ('reverse', 'quantity')),
	CONSTRAINT "chk_inv_waste_corrections_quantity" CHECK("inv_waste_corrections"."previous_quantity" > 0 and "inv_waste_corrections"."new_quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_waste_corrections_client` ON `inv_waste_corrections` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_waste_corrections_waste` ON `inv_waste_corrections` (`waste_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_waste_corrections_group` ON `inv_waste_corrections` (`group_id`);--> statement-breakpoint
CREATE TABLE `inv_waste_dishes` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`location_id` text NOT NULL,
	`menu_item_id` text NOT NULL,
	`variant_id` text,
	`options` text,
	`quantity` integer NOT NULL,
	`basis` text NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`business_date` text NOT NULL,
	`source` text DEFAULT 'operator' NOT NULL,
	`device_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_waste_dishes_quantity" CHECK("inv_waste_dishes"."quantity" > 0),
	CONSTRAINT "chk_inv_waste_dishes_reason" CHECK("inv_waste_dishes"."reason" in ('expired', 'spoiled', 'over_prepped', 'dropped', 'returned', 'staff_meal', 'cancelled_after_cooking', 'remade_at_till', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_waste_dishes_client` ON `inv_waste_dishes` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_waste_dishes_location_date` ON `inv_waste_dishes` (`location_id`,`business_date`);--> statement-breakpoint
ALTER TABLE `inv_transfer_lines` ADD `asked_quantity` integer;--> statement-breakpoint
ALTER TABLE `inv_transfer_lines` ADD `price_micro` integer;--> statement-breakpoint
ALTER TABLE `inv_transfer_lines` ADD `price_source` text;--> statement-breakpoint
ALTER TABLE `inv_transfers` ADD `edited_at` integer;--> statement-breakpoint
ALTER TABLE `inv_transfers` ADD `edited_by_location_id` text;--> statement-breakpoint
ALTER TABLE `inv_waste` ADD `group_id` text;--> statement-breakpoint
CREATE INDEX `idx_inv_waste_group` ON `inv_waste` (`group_id`);--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers; regenerating loses them).
-- Transfer lines: once sent, the price fixed at send (and what was first asked
-- for) never change, like the quantity and cost beside them.
DROP TRIGGER `inv_transfer_lines_frozen`;
--> statement-breakpoint
CREATE TRIGGER `inv_transfer_lines_frozen` BEFORE UPDATE ON `inv_transfer_lines`
WHEN (SELECT status FROM inv_transfers WHERE id = OLD.transfer_id) IN ('received', 'cancelled')
	OR (
		(SELECT status FROM inv_transfers WHERE id = OLD.transfer_id) = 'sent'
		AND (
			NEW.item_id IS NOT OLD.item_id
			OR NEW.requested_quantity IS NOT OLD.requested_quantity
			OR NEW.sent_quantity IS NOT OLD.sent_quantity
			OR NEW.unit_cost_micro IS NOT OLD.unit_cost_micro
			OR NEW.price_micro IS NOT OLD.price_micro
			OR NEW.price_source IS NOT OLD.price_source
			OR NEW.asked_quantity IS NOT OLD.asked_quantity
		)
	)
BEGIN SELECT RAISE(ABORT, 'inventory transfer lines are frozen'); END;
--> statement-breakpoint
-- Waste: the group id joins the append-only guard.
DROP TRIGGER `inv_waste_no_update`;
--> statement-breakpoint
CREATE TRIGGER `inv_waste_no_update` BEFORE UPDATE ON `inv_waste`
WHEN NOT (
	NEW.note IS NULL
	AND NEW.id IS OLD.id
	AND NEW.location_id IS OLD.location_id
	AND NEW.item_id IS OLD.item_id
	AND NEW.dish_ref IS OLD.dish_ref
	AND NEW.quantity IS OLD.quantity
	AND NEW.reason IS OLD.reason
	AND NEW.value_minor IS OLD.value_minor
	AND NEW.currency IS OLD.currency
	AND NEW.actor_kind IS OLD.actor_kind
	AND NEW.actor_id IS OLD.actor_id
	AND NEW.client_id IS OLD.client_id
	AND NEW.reverses_id IS OLD.reverses_id
	AND NEW.business_date IS OLD.business_date
	AND NEW.source IS OLD.source
	AND NEW.device_id IS OLD.device_id
	AND NEW.late_sync IS OLD.late_sync
	AND NEW.group_id IS OLD.group_id
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'inv_waste is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_waste_dishes_no_delete` BEFORE DELETE ON `inv_waste_dishes`
BEGIN SELECT RAISE(ABORT, 'inv_waste_dishes is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_waste_dishes_no_update` BEFORE UPDATE ON `inv_waste_dishes`
BEGIN SELECT RAISE(ABORT, 'inv_waste_dishes is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_waste_corrections_no_delete` BEFORE DELETE ON `inv_waste_corrections`
BEGIN SELECT RAISE(ABORT, 'inv_waste_corrections is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_waste_corrections_no_update` BEFORE UPDATE ON `inv_waste_corrections`
BEGIN SELECT RAISE(ABORT, 'inv_waste_corrections is append-only'); END;
--> statement-breakpoint
-- A correction names a real entry (not a reversing row), never raises the
-- figure above what a later correction already set it to, and never brings a
-- reversed (zero) entry back.
CREATE TRIGGER `inv_waste_corrections_matches` BEFORE INSERT ON `inv_waste_corrections`
WHEN NOT EXISTS (
	SELECT 1 FROM `inv_waste` AS original
	WHERE original.id = NEW.waste_id AND original.reverses_id IS NULL
)
OR NEW.previous_quantity IS NOT COALESCE(
	(SELECT c.new_quantity FROM `inv_waste_corrections` AS c WHERE c.waste_id = NEW.waste_id ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1),
	(SELECT original.quantity FROM `inv_waste` AS original WHERE original.id = NEW.waste_id)
)
BEGIN SELECT RAISE(ABORT, 'inventory waste correction does not match'); END;

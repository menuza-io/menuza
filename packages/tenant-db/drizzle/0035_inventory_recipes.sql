CREATE TABLE `inv_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`location_id` text NOT NULL,
	`queued_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`last_error` text,
	`settled_at` integer,
	CONSTRAINT "chk_inv_outbox_source_type" CHECK("inv_outbox"."source_type" in ('restaurant_order', 'pos_order', 'pos_void')),
	CONSTRAINT "chk_inv_outbox_attempts" CHECK("inv_outbox"."attempts" >= 0),
	CONSTRAINT "chk_inv_outbox_error" CHECK("inv_outbox"."last_error" is null or length("inv_outbox"."last_error") <= 200)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_outbox_unsettled` ON `inv_outbox` (`source_type`,`source_id`) WHERE "inv_outbox"."settled_at" is null;--> statement-breakpoint
CREATE INDEX `idx_inv_outbox_due` ON `inv_outbox` (`next_attempt_at`) WHERE "inv_outbox"."settled_at" is null;--> statement-breakpoint
CREATE INDEX `idx_inv_outbox_settled` ON `inv_outbox` (`settled_at`);--> statement-breakpoint
CREATE TABLE `inv_recipe_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`usable_bp` integer DEFAULT 10000 NOT NULL,
	`mode` text DEFAULT 'add' NOT NULL,
	`replaces_item_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `inv_recipes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replaces_item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_recipe_lines_mode" CHECK("inv_recipe_lines"."mode" in ('add', 'replace')),
	CONSTRAINT "chk_inv_recipe_lines_amounts" CHECK("inv_recipe_lines"."quantity" between 1 and 9000000000 and "inv_recipe_lines"."usable_bp" between 1 and 10000),
	CONSTRAINT "chk_inv_recipe_lines_replaces" CHECK(("inv_recipe_lines"."mode" = 'add' and "inv_recipe_lines"."replaces_item_id" is null) or ("inv_recipe_lines"."mode" = 'replace' and "inv_recipe_lines"."replaces_item_id" is not null and "inv_recipe_lines"."replaces_item_id" <> "inv_recipe_lines"."item_id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_recipe_lines_item` ON `inv_recipe_lines` (`recipe_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_recipe_lines_recipe` ON `inv_recipe_lines` (`recipe_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_inv_recipe_lines_item` ON `inv_recipe_lines` (`item_id`);--> statement-breakpoint
CREATE TABLE `inv_recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`makes_quantity` integer,
	`multiplier_bp` integer,
	`typed_cost_minor` integer,
	`typed_cost_currency` text,
	`method` text,
	`effective_from` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`superseded_at` integer,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_recipes_owner_kind" CHECK("inv_recipes"."owner_kind" in ('menu_item', 'variant', 'option', 'made_item')),
	CONSTRAINT "chk_inv_recipes_created_by_kind" CHECK("inv_recipes"."created_by_kind" in ('operator', 'staff', 'system')),
	CONSTRAINT "chk_inv_recipes_version" CHECK("inv_recipes"."version" >= 1),
	CONSTRAINT "chk_inv_recipes_makes" CHECK(("inv_recipes"."owner_kind" = 'made_item' and "inv_recipes"."makes_quantity" > 0) or ("inv_recipes"."owner_kind" <> 'made_item' and "inv_recipes"."makes_quantity" is null)),
	CONSTRAINT "chk_inv_recipes_multiplier" CHECK("inv_recipes"."multiplier_bp" is null or ("inv_recipes"."owner_kind" = 'variant' and "inv_recipes"."multiplier_bp" between 1 and 1000000)),
	CONSTRAINT "chk_inv_recipes_typed_cost" CHECK(("inv_recipes"."typed_cost_minor" is null and "inv_recipes"."typed_cost_currency" is null) or ("inv_recipes"."typed_cost_minor" >= 0 and "inv_recipes"."typed_cost_currency" is not null and "inv_recipes"."owner_kind" <> 'made_item')),
	CONSTRAINT "chk_inv_recipes_effective" CHECK("inv_recipes"."effective_from" >= 0 and ("inv_recipes"."superseded_at" is null or "inv_recipes"."superseded_at" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_recipes_owner_version` ON `inv_recipes` (`owner_kind`,`owner_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_recipes_current` ON `inv_recipes` (`owner_kind`,`owner_id`) WHERE "inv_recipes"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX `idx_inv_recipes_owner_effective` ON `inv_recipes` (`owner_kind`,`owner_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `inv_sale_usage` (
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`source_type`, `source_id`, `item_id`, `location_id`),
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_sale_usage_source_type" CHECK("inv_sale_usage"."source_type" in ('restaurant_order', 'pos_order', 'pos_void')),
	CONSTRAINT "chk_inv_sale_usage_quantity" CHECK("inv_sale_usage"."quantity" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_inv_sale_usage_item_location` ON `inv_sale_usage` (`item_id`,`location_id`);--> statement-breakpoint
ALTER TABLE `inv_items` ADD `batch_counted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `auto_sold_out` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Item flags. Only a made item can be counted in batches (CHECK constraints
-- cannot be added by ALTER TABLE ADD COLUMN, so triggers carry the rule).
CREATE TRIGGER `inv_items_batch_counted_insert` BEFORE INSERT ON `inv_items`
WHEN NEW.batch_counted = 1 AND NEW.kind IS NOT 'made'
BEGIN SELECT RAISE(ABORT, 'only a made item can be counted in batches'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_items_batch_counted_update` BEFORE UPDATE OF `batch_counted`, `kind` ON `inv_items`
WHEN NEW.batch_counted = 1 AND NEW.kind IS NOT 'made'
BEGIN SELECT RAISE(ABORT, 'only a made item can be counted in batches'); END;
--> statement-breakpoint
-- Recipes are never deleted: a sale is costed with the version in force at
-- its time.
CREATE TRIGGER `inv_recipes_no_delete` BEFORE DELETE ON `inv_recipes`
BEGIN SELECT RAISE(ABORT, 'inv_recipes is append-only'); END;
--> statement-breakpoint
-- A recipe row never changes, except that the current one is stamped
-- superseded, once, when its successor is written.
CREATE TRIGGER `inv_recipes_facts_fixed` BEFORE UPDATE ON `inv_recipes`
WHEN NOT (
	OLD.superseded_at IS NULL
	AND NEW.superseded_at IS NOT NULL
	AND NEW.id IS OLD.id
	AND NEW.owner_kind IS OLD.owner_kind
	AND NEW.owner_id IS OLD.owner_id
	AND NEW.version IS OLD.version
	AND NEW.makes_quantity IS OLD.makes_quantity
	AND NEW.multiplier_bp IS OLD.multiplier_bp
	AND NEW.typed_cost_minor IS OLD.typed_cost_minor
	AND NEW.typed_cost_currency IS OLD.typed_cost_currency
	AND NEW.method IS OLD.method
	AND NEW.effective_from IS OLD.effective_from
	AND NEW.created_by_kind IS OLD.created_by_kind
	AND NEW.created_by_id IS OLD.created_by_id
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'inv_recipes is append-only'); END;
--> statement-breakpoint
-- A made item's recipe belongs to an existing made item.
CREATE TRIGGER `inv_recipes_made_item_owner` BEFORE INSERT ON `inv_recipes`
WHEN NEW.owner_kind = 'made_item'
	AND NOT EXISTS (SELECT 1 FROM `inv_items` WHERE `id` = NEW.owner_id AND `kind` = 'made')
BEGIN SELECT RAISE(ABORT, 'a made item recipe needs a made item'); END;
--> statement-breakpoint
-- A new version starts no earlier than the one before it, so "the version in
-- force at a time" is the newest row at or before that time.
CREATE TRIGGER `inv_recipes_effective_forward` BEFORE INSERT ON `inv_recipes`
WHEN NEW.effective_from < COALESCE((
	SELECT MAX(`effective_from`) FROM `inv_recipes`
	WHERE `owner_kind` = NEW.owner_kind AND `owner_id` = NEW.owner_id
), 0)
BEGIN SELECT RAISE(ABORT, 'inventory recipe versions only move forward'); END;
--> statement-breakpoint
-- Lines of a recipe: only while it is current; never on a typed-cost recipe or
-- a variant that is a multiple of its item's recipe; replace only on options;
-- a made item never lists itself.
CREATE TRIGGER `inv_recipe_lines_insert_valid` BEFORE INSERT ON `inv_recipe_lines`
WHEN (SELECT `superseded_at` FROM `inv_recipes` WHERE `id` = NEW.recipe_id) IS NOT NULL
	OR (SELECT COUNT(*) FROM `inv_recipes` WHERE `id` = NEW.recipe_id) = 0
BEGIN SELECT RAISE(ABORT, 'inventory recipe lines are frozen'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_recipe_lines_shape_valid` BEFORE INSERT ON `inv_recipe_lines`
WHEN EXISTS (
	SELECT 1 FROM `inv_recipes` r WHERE r.`id` = NEW.recipe_id AND (
		r.`typed_cost_minor` IS NOT NULL
		OR r.`multiplier_bp` IS NOT NULL
		OR (NEW.mode = 'replace' AND r.`owner_kind` <> 'option')
	)
)
BEGIN SELECT RAISE(ABORT, 'inventory recipe line does not fit its recipe'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_recipe_lines_no_self` BEFORE INSERT ON `inv_recipe_lines`
WHEN EXISTS (
	SELECT 1 FROM `inv_recipes` r
	WHERE r.`id` = NEW.recipe_id AND r.`owner_kind` = 'made_item' AND r.`owner_id` = NEW.item_id
)
BEGIN SELECT RAISE(ABORT, 'a made item cannot be its own ingredient'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_recipe_lines_frozen_update` BEFORE UPDATE ON `inv_recipe_lines`
WHEN (SELECT `superseded_at` FROM `inv_recipes` WHERE `id` = OLD.recipe_id) IS NOT NULL
	OR NEW.recipe_id IS NOT OLD.recipe_id
BEGIN SELECT RAISE(ABORT, 'inventory recipe lines are frozen'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_recipe_lines_no_self_update` BEFORE UPDATE OF `item_id` ON `inv_recipe_lines`
WHEN EXISTS (
	SELECT 1 FROM `inv_recipes` r
	WHERE r.`id` = NEW.recipe_id AND r.`owner_kind` = 'made_item' AND r.`owner_id` = NEW.item_id
)
BEGIN SELECT RAISE(ABORT, 'a made item cannot be its own ingredient'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_recipe_lines_frozen_delete` BEFORE DELETE ON `inv_recipe_lines`
WHEN (SELECT `superseded_at` FROM `inv_recipes` WHERE `id` = OLD.recipe_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'inventory recipe lines are frozen'); END;

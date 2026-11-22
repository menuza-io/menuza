CREATE TABLE `inv_item_group_members` (
	`group_item_id` text NOT NULL,
	`member_item_id` text NOT NULL,
	`rank` integer NOT NULL,
	`member_quantity` integer DEFAULT 1 NOT NULL,
	`group_quantity` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`group_item_id`, `member_item_id`),
	FOREIGN KEY (`group_item_id`) REFERENCES `inv_item_groups`(`item_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`member_item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_item_group_members_amounts" CHECK("inv_item_group_members"."rank" >= 0 and "inv_item_group_members"."member_quantity" > 0 and "inv_item_group_members"."group_quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_item_group_members_member` ON `inv_item_group_members` (`member_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_item_group_members_rank` ON `inv_item_group_members` (`group_item_id`,`rank`);--> statement-breakpoint
CREATE TABLE `inv_item_groups` (
	`item_id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `inv_merges` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`kept_id` text NOT NULL,
	`merged_id` text NOT NULL,
	`status` text DEFAULT 'done' NOT NULL,
	`snapshot` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`undo_until` integer NOT NULL,
	`undone_at` integer,
	CONSTRAINT "chk_inv_merges_kind" CHECK("inv_merges"."kind" in ('item', 'supplier')),
	CONSTRAINT "chk_inv_merges_status" CHECK("inv_merges"."status" in ('done', 'undone'))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_merges_kept` ON `inv_merges` (`kind`,`kept_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_merges_merged` ON `inv_merges` (`kind`,`merged_id`);--> statement-breakpoint
CREATE TABLE `inv_setup_dismissals` (
	`key` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`dismissed_by_kind` text NOT NULL,
	`dismissed_by_id` text,
	`dismissed_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inv_sold_out_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`kind` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`cause_item_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`sent_at` integer,
	`event_id` text,
	FOREIGN KEY (`cause_item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_sold_out_alerts_kind" CHECK("inv_sold_out_alerts"."kind" in ('out', 'back'))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_sold_out_alerts_pending` ON `inv_sold_out_alerts` (`location_id`,`kind`,`sent_at`);--> statement-breakpoint
CREATE TABLE `inv_unit_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`from_unit` text NOT NULL,
	`to_unit` text NOT NULL,
	`factor_num` integer NOT NULL,
	`factor_den` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_unit_changes_factor" CHECK("inv_unit_changes"."factor_num" > 0 and "inv_unit_changes"."factor_den" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_inv_unit_changes_item` ON `inv_unit_changes` (`item_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `inv_items` ADD `merged_into_id` text;--> statement-breakpoint
ALTER TABLE `inv_suppliers` ADD `merged_into_id` text;
--> statement-breakpoint
-- A base unit may change once the item has movements only inside the
-- transaction that records the change (an open `inv_unit_changes` row).
DROP TRIGGER `inv_items_base_unit_fixed`;
--> statement-breakpoint
CREATE TRIGGER `inv_items_base_unit_fixed` BEFORE UPDATE OF `base_unit` ON `inv_items`
WHEN NEW.base_unit IS NOT OLD.base_unit AND EXISTS (SELECT 1 FROM `inv_movements` WHERE `item_id` = OLD.id)
	AND NOT EXISTS (
		SELECT 1 FROM `inv_unit_changes`
		WHERE `item_id` = OLD.id AND `completed_at` IS NULL
			AND `from_unit` = OLD.base_unit AND `to_unit` = NEW.base_unit
	)
BEGIN SELECT RAISE(ABORT, 'inventory item unit is fixed'); END;
--> statement-breakpoint
DROP TRIGGER `inv_item_units_size_fixed`;
--> statement-breakpoint
CREATE TRIGGER `inv_item_units_size_fixed` BEFORE UPDATE ON `inv_item_units`
WHEN OLD.used_at IS NOT NULL AND (
	NEW.base_quantity IS NOT OLD.base_quantity
	OR NEW.item_id IS NOT OLD.item_id
	OR NEW.used_at IS NULL
) AND NOT EXISTS (
	SELECT 1 FROM `inv_unit_changes`
	WHERE `item_id` = OLD.item_id AND `completed_at` IS NULL
)
BEGIN SELECT RAISE(ABORT, 'inventory unit in use'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_unit_changes_closed_final` BEFORE UPDATE ON `inv_unit_changes`
WHEN OLD.completed_at IS NOT NULL
	OR NEW.id IS NOT OLD.id
	OR NEW.item_id IS NOT OLD.item_id
	OR NEW.from_unit IS NOT OLD.from_unit
	OR NEW.to_unit IS NOT OLD.to_unit
	OR NEW.factor_num IS NOT OLD.factor_num
	OR NEW.factor_den IS NOT OLD.factor_den
BEGIN SELECT RAISE(ABORT, 'inv_unit_changes is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_unit_changes_no_delete` BEFORE DELETE ON `inv_unit_changes`
BEGIN SELECT RAISE(ABORT, 'inv_unit_changes is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_item_group_members_no_nesting` BEFORE INSERT ON `inv_item_group_members`
WHEN EXISTS (SELECT 1 FROM `inv_item_groups` WHERE `item_id` = NEW.member_item_id)
	OR EXISTS (SELECT 1 FROM `inv_item_group_members` WHERE `member_item_id` = NEW.group_item_id)
BEGIN SELECT RAISE(ABORT, 'inventory groups cannot nest'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_movements_group_has_no_stock` BEFORE INSERT ON `inv_movements`
WHEN EXISTS (SELECT 1 FROM `inv_item_groups` WHERE `item_id` = NEW.item_id)
BEGIN SELECT RAISE(ABORT, 'inventory group has no stock'); END;

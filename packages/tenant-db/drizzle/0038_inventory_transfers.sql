CREATE TABLE `inv_transfer_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`transfer_id` text NOT NULL,
	`item_id` text NOT NULL,
	`requested_quantity` integer NOT NULL,
	`sent_quantity` integer,
	`received_quantity` integer,
	`unit_cost_micro` integer,
	`cost_currency` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`transfer_id`) REFERENCES `inv_transfers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_transfer_lines_quantities" CHECK("inv_transfer_lines"."requested_quantity" >= 0 and ("inv_transfer_lines"."sent_quantity" is null or "inv_transfer_lines"."sent_quantity" >= 0) and ("inv_transfer_lines"."received_quantity" is null or "inv_transfer_lines"."received_quantity" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_transfer_lines_item` ON `inv_transfer_lines` (`transfer_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_transfer_lines_item` ON `inv_transfer_lines` (`item_id`);--> statement-breakpoint
CREATE TABLE `inv_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`from_location_id` text NOT NULL,
	`to_location_id` text NOT NULL,
	`note` text,
	`client_id` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`sent_at` integer,
	`sent_by_kind` text,
	`sent_by_id` text,
	`received_at` integer,
	`received_by_kind` text,
	`received_by_id` text,
	`cancelled_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_transfers_kind" CHECK("inv_transfers"."kind" in ('transfer', 'request')),
	CONSTRAINT "chk_inv_transfers_status" CHECK("inv_transfers"."status" in ('requested', 'draft', 'sent', 'received', 'cancelled')),
	CONSTRAINT "chk_inv_transfers_places" CHECK("inv_transfers"."from_location_id" <> "inv_transfers"."to_location_id"),
	CONSTRAINT "chk_inv_transfers_start" CHECK(("inv_transfers"."kind" = 'request' and "inv_transfers"."status" <> 'draft') or ("inv_transfers"."kind" = 'transfer' and "inv_transfers"."status" <> 'requested'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_transfers_number` ON `inv_transfers` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_transfers_client` ON `inv_transfers` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_transfers_from` ON `inv_transfers` (`from_location_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_inv_transfers_to` ON `inv_transfers` (`to_location_id`,`status`);--> statement-breakpoint
-- A transfer only moves forward, and a closed one is final.
CREATE TRIGGER `inv_transfers_closed_final` BEFORE UPDATE ON `inv_transfers`
WHEN OLD.status IN ('received', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'inventory transfer is closed'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_transfers_forward_only` BEFORE UPDATE ON `inv_transfers`
WHEN NOT (
	NEW.status = OLD.status
	OR (OLD.status IN ('requested', 'draft') AND NEW.status IN ('sent', 'cancelled'))
	OR (OLD.status = 'sent' AND NEW.status = 'received')
)
BEGIN SELECT RAISE(ABORT, 'inventory transfer cannot go back'); END;
--> statement-breakpoint
-- Lines change only while the transfer is requested or a draft; once sent, only what arrived is written.
CREATE TRIGGER `inv_transfer_lines_frozen` BEFORE UPDATE ON `inv_transfer_lines`
WHEN (SELECT status FROM inv_transfers WHERE id = OLD.transfer_id) IN ('received', 'cancelled')
	OR (
		(SELECT status FROM inv_transfers WHERE id = OLD.transfer_id) = 'sent'
		AND (
			NEW.item_id IS NOT OLD.item_id
			OR NEW.requested_quantity IS NOT OLD.requested_quantity
			OR NEW.sent_quantity IS NOT OLD.sent_quantity
			OR NEW.unit_cost_micro IS NOT OLD.unit_cost_micro
		)
	)
BEGIN SELECT RAISE(ABORT, 'inventory transfer lines are frozen'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_transfer_lines_no_insert` BEFORE INSERT ON `inv_transfer_lines`
WHEN (SELECT status FROM inv_transfers WHERE id = NEW.transfer_id) NOT IN ('requested', 'draft')
BEGIN SELECT RAISE(ABORT, 'inventory transfer lines are frozen'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_transfer_lines_no_delete` BEFORE DELETE ON `inv_transfer_lines`
WHEN (SELECT status FROM inv_transfers WHERE id = OLD.transfer_id) NOT IN ('requested', 'draft')
BEGIN SELECT RAISE(ABORT, 'inventory transfer lines are frozen'); END;

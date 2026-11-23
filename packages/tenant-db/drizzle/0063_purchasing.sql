CREATE TABLE `inv_setup_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'reading' NOT NULL,
	`total_files` integer NOT NULL,
	`completed_files` integer DEFAULT 0 NOT NULL,
	`failed_files` integer DEFAULT 0 NOT NULL,
	`proposal_json` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`applied_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_setup_imports_status" CHECK("inv_setup_imports"."status" in ('reading', 'ready', 'applied', 'failed')),
	CONSTRAINT "chk_inv_setup_imports_actor" CHECK("inv_setup_imports"."created_by_kind" in ('operator', 'staff', 'system')),
	CONSTRAINT "chk_inv_setup_imports_counts" CHECK("inv_setup_imports"."total_files" > 0 and "inv_setup_imports"."completed_files" >= 0 and "inv_setup_imports"."failed_files" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_inv_setup_imports_status` ON `inv_setup_imports` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `inv_setup_import_files` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`file_kind` text NOT NULL,
	`storage_key` text,
	`inline_content` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`read_json` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `inv_setup_imports`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_inv_setup_import_files_kind" CHECK("inv_setup_import_files"."file_kind" in ('image', 'pdf', 'csv', 'xlsx')),
	CONSTRAINT "chk_inv_setup_import_files_status" CHECK("inv_setup_import_files"."status" in ('pending', 'reading', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_setup_import_files_import` ON `inv_setup_import_files` (`import_id`,`status`);--> statement-breakpoint
CREATE TABLE `inv_supplier_product_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`supplier_product_id` text,
	`item_id` text NOT NULL,
	`pack_name` text,
	`pack_base_quantity` integer NOT NULL,
	`price_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`delivery_line_id` text,
	`effective_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `inv_suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_product_id`) REFERENCES `inv_supplier_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivery_line_id`) REFERENCES `inv_delivery_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_supplier_product_prices_source" CHECK("inv_supplier_product_prices"."source" in ('price_list', 'setup_import', 'invoice', 'delivery', 'cash_purchase')),
	CONSTRAINT "chk_inv_supplier_product_prices_amounts" CHECK("inv_supplier_product_prices"."price_minor" >= 0 and "inv_supplier_product_prices"."pack_base_quantity" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_inv_supplier_product_prices_product` ON `inv_supplier_product_prices` (`supplier_product_id`,`effective_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_supplier_product_prices_item` ON `inv_supplier_product_prices` (`item_id`,`effective_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_supplier_product_prices_supplier` ON `inv_supplier_product_prices` (`supplier_id`,`item_id`,`effective_at`);--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `as_ordered` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `undo_until` integer;--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `is_credit` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `credit_for_delivery_id` text;--> statement-breakpoint
ALTER TABLE `inv_items` ADD `is_draft` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `confirmed_by_kind` text;--> statement-breakpoint
ALTER TABLE `inv_orders` ADD `confirmed_by_id` text;--> statement-breakpoint
ALTER TABLE `inv_suppliers` ADD `is_market_cash` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_suppliers_market_cash` ON `inv_suppliers` (`is_market_cash`) WHERE "inv_suppliers"."is_market_cash" = 1 and "inv_suppliers"."archived_at" is null;
--> statement-breakpoint
-- Quantity-only delivery lines can be confirmed once (allowing quantity/pack
-- corrections from invoice review while `priced_at` is still null).
DROP TRIGGER `inv_delivery_lines_no_update`;
--> statement-breakpoint
CREATE TRIGGER `inv_delivery_lines_no_update` BEFORE UPDATE ON `inv_delivery_lines`
WHEN NOT (
	OLD.priced_at IS NULL
	AND NEW.priced_at IS NOT NULL
	AND (SELECT `quantity_only` FROM `inv_deliveries` WHERE `id` = OLD.delivery_id) = 1
	AND NEW.id IS OLD.id
	AND NEW.delivery_id IS OLD.delivery_id
	AND NEW.item_id IS OLD.item_id
	AND NEW.real_weight_quantity IS OLD.real_weight_quantity
	AND NEW.order_line_id IS OLD.order_line_id
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'inv_delivery_lines is append-only'); END;
--> statement-breakpoint
DROP TRIGGER `inv_deliveries_facts_fixed`;
--> statement-breakpoint
CREATE TRIGGER `inv_deliveries_facts_fixed` BEFORE UPDATE ON `inv_deliveries`
WHEN NEW.order_id IS NOT OLD.order_id
	OR NEW.quantity_only IS NOT OLD.quantity_only
	OR NEW.source IS NOT OLD.source
	OR NEW.late_sync IS NOT OLD.late_sync
	OR NEW.location_id IS NOT OLD.location_id
	OR NEW.supplier_id IS NOT OLD.supplier_id
	OR NEW.as_ordered IS NOT OLD.as_ordered
	OR NEW.undo_until IS NOT OLD.undo_until
	OR NEW.is_credit IS NOT OLD.is_credit
	OR NEW.credit_for_delivery_id IS NOT OLD.credit_for_delivery_id
	OR (OLD.prices_confirmed_at IS NOT NULL AND NEW.prices_confirmed_at IS NOT OLD.prices_confirmed_at)
BEGIN SELECT RAISE(ABORT, 'inventory delivery facts are fixed'); END;
--> statement-breakpoint
DROP TRIGGER `inv_orders_closed_final`;
--> statement-breakpoint
CREATE TRIGGER `inv_orders_closed_final` BEFORE UPDATE ON `inv_orders`
WHEN OLD.status IN ('received', 'cancelled')
	AND NOT (
		OLD.status = 'received'
		AND NEW.status IN ('sent', 'partly_received')
		AND NEW.closed_at IS NULL
		AND NEW.expected_date IS OLD.expected_date
		AND NEW.note IS OLD.note
		AND NEW.currency IS OLD.currency
		AND NEW.sent_at IS OLD.sent_at
		AND NEW.sent_via IS OLD.sent_via
		AND EXISTS (
			SELECT 1 FROM `inv_deliveries`
			WHERE `inv_deliveries`.`order_id` = OLD.id
				AND `inv_deliveries`.`as_ordered` = 1
				AND `inv_deliveries`.`status` = 'cancelled'
		)
	)
	AND (
		NEW.status IS NOT OLD.status
		OR NEW.expected_date IS NOT OLD.expected_date
		OR NEW.note IS NOT OLD.note
		OR NEW.currency IS NOT OLD.currency
		OR NEW.sent_at IS NOT OLD.sent_at
		OR NEW.sent_via IS NOT OLD.sent_via
		OR NEW.closed_at IS NOT OLD.closed_at
		OR NEW.confirmed_at IS NOT OLD.confirmed_at
		OR NEW.confirmed_by_kind IS NOT OLD.confirmed_by_kind
		OR NEW.confirmed_by_id IS NOT OLD.confirmed_by_id
	)
BEGIN SELECT RAISE(ABORT, 'inventory order is closed'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_orders_confirmed_kind_valid` BEFORE UPDATE OF `confirmed_by_kind` ON `inv_orders`
WHEN NEW.confirmed_by_kind IS NOT NULL AND NEW.confirmed_by_kind NOT IN ('operator', 'staff', 'system')
BEGIN SELECT RAISE(ABORT, 'inventory order confirmed_by_kind invalid'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_supplier_product_prices_no_update` BEFORE UPDATE ON `inv_supplier_product_prices`
BEGIN SELECT RAISE(ABORT, 'inv_supplier_product_prices is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_supplier_product_prices_no_delete` BEFORE DELETE ON `inv_supplier_product_prices`
BEGIN SELECT RAISE(ABORT, 'inv_supplier_product_prices is append-only'); END;
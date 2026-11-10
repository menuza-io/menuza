CREATE TABLE `inv_alert_log` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`location_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`count` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sent_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_alert_log_kind" CHECK("inv_alert_log"."kind" in ('inventory_low_stock', 'inventory_count_review', 'inventory_delivery_due', 'inventory_price_rise')),
	CONSTRAINT "chk_inv_alert_log_status" CHECK("inv_alert_log"."status" in ('sent', 'pending')),
	CONSTRAINT "chk_inv_alert_log_count" CHECK("inv_alert_log"."count" >= 1),
	CONSTRAINT "chk_inv_alert_log_attempts" CHECK("inv_alert_log"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_alert_log_event` ON `inv_alert_log` (`kind`,`location_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_inv_alert_log_status` ON `inv_alert_log` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `inv_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`item_id` text NOT NULL,
	`supplier_product_id` text,
	`pack_name` text NOT NULL,
	`pack_base_quantity` integer NOT NULL,
	`priced_by_weight` integer DEFAULT false NOT NULL,
	`packs` integer NOT NULL,
	`quantity` integer NOT NULL,
	`price_minor` integer,
	`suggested_packs` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `inv_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_product_id`) REFERENCES `inv_supplier_products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_order_lines_amounts" CHECK("inv_order_lines"."packs" > 0 and "inv_order_lines"."quantity" > 0 and "inv_order_lines"."pack_base_quantity" > 0 and ("inv_order_lines"."price_minor" is null or "inv_order_lines"."price_minor" >= 0) and ("inv_order_lines"."suggested_packs" is null or "inv_order_lines"."suggested_packs" >= 0))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_order_lines_order` ON `inv_order_lines` (`order_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_inv_order_lines_item` ON `inv_order_lines` (`item_id`);--> statement-breakpoint
CREATE TABLE `inv_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`client_id` text NOT NULL,
	`location_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`expected_date` text,
	`note` text,
	`currency` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`sent_at` integer,
	`sent_via` text,
	`closed_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `inv_suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_orders_status" CHECK("inv_orders"."status" in ('draft', 'sent', 'partly_received', 'received', 'cancelled')),
	CONSTRAINT "chk_inv_orders_created_by_kind" CHECK("inv_orders"."created_by_kind" in ('operator', 'staff', 'system')),
	CONSTRAINT "chk_inv_orders_sent_via" CHECK("inv_orders"."sent_via" is null or "inv_orders"."sent_via" in ('email', 'whatsapp', 'copy', 'pdf')),
	CONSTRAINT "chk_inv_orders_number" CHECK("inv_orders"."number" >= 1),
	CONSTRAINT "chk_inv_orders_closed" CHECK("inv_orders"."status" not in ('received', 'cancelled') or "inv_orders"."closed_at" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_orders_number` ON `inv_orders` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_orders_client` ON `inv_orders` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_orders_location_status` ON `inv_orders` (`location_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_orders_supplier` ON `inv_orders` (`supplier_id`);--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `photo_content_type` text;--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `photo_uploaded_at` integer;--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `order_id` text REFERENCES inv_orders(id);--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `quantity_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `prices_confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `inv_deliveries` ADD `late_sync` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_inv_deliveries_order` ON `inv_deliveries` (`order_id`);--> statement-breakpoint
ALTER TABLE `inv_delivery_lines` ADD `order_line_id` text REFERENCES inv_order_lines(id);--> statement-breakpoint
ALTER TABLE `inv_delivery_lines` ADD `priced_at` integer;--> statement-breakpoint
CREATE INDEX `idx_inv_delivery_lines_order_line` ON `inv_delivery_lines` (`order_line_id`);--> statement-breakpoint
ALTER TABLE `inv_settings` ADD `any_staff_can_receive` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_settings` ADD `next_order_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_waste` ADD `source` text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE `inv_waste` ADD `device_id` text;--> statement-breakpoint
ALTER TABLE `inv_waste` ADD `late_sync` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_inv_waste_device_created` ON `inv_waste` (`device_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `inventory_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `inventory_disabled_at` integer;--> statement-breakpoint
ALTER TABLE `pos_pairing_codes` ADD `inventory_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Lines written before this migration were all priced when received.
DROP TRIGGER `inv_delivery_lines_no_update`;
--> statement-breakpoint
UPDATE `inv_delivery_lines` SET `priced_at` = `created_at` WHERE `priced_at` IS NULL;
--> statement-breakpoint
-- A delivery line is append-only, with ONE exception: a line of a quantity-only
-- delivery may be priced once (confirm prices), while priced_at is still null.
CREATE TRIGGER `inv_delivery_lines_no_update` BEFORE UPDATE ON `inv_delivery_lines`
WHEN NOT (
	OLD.priced_at IS NULL
	AND NEW.priced_at IS NOT NULL
	AND (SELECT `quantity_only` FROM `inv_deliveries` WHERE `id` = OLD.delivery_id) = 1
	AND NEW.id IS OLD.id
	AND NEW.delivery_id IS OLD.delivery_id
	AND NEW.item_id IS OLD.item_id
	AND NEW.supplier_product_id IS OLD.supplier_product_id
	AND NEW.quantity IS OLD.quantity
	AND NEW.pack_name IS OLD.pack_name
	AND NEW.pack_base_quantity IS OLD.pack_base_quantity
	AND NEW.packs IS OLD.packs
	AND NEW.real_weight_quantity IS OLD.real_weight_quantity
	AND NEW.order_line_id IS OLD.order_line_id
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'inv_delivery_lines is append-only'); END;
--> statement-breakpoint
-- What a delivery is cannot change after it is recorded: its order, whether it
-- came without prices, where it was made, and when its prices were confirmed.
CREATE TRIGGER `inv_deliveries_facts_fixed` BEFORE UPDATE ON `inv_deliveries`
WHEN NEW.order_id IS NOT OLD.order_id
	OR NEW.quantity_only IS NOT OLD.quantity_only
	OR NEW.source IS NOT OLD.source
	OR NEW.late_sync IS NOT OLD.late_sync
	OR NEW.location_id IS NOT OLD.location_id
	OR NEW.supplier_id IS NOT OLD.supplier_id
	OR (OLD.prices_confirmed_at IS NOT NULL AND NEW.prices_confirmed_at IS NOT OLD.prices_confirmed_at)
BEGIN SELECT RAISE(ABORT, 'inventory delivery facts are fixed'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_deliveries_photo_type_insert` BEFORE INSERT ON `inv_deliveries`
WHEN NEW.photo_content_type IS NOT NULL
	AND NEW.photo_content_type NOT IN ('image/jpeg', 'image/png', 'image/webp')
BEGIN SELECT RAISE(ABORT, 'inventory invoice photo type not allowed'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_deliveries_photo_type_update` BEFORE UPDATE OF `photo_content_type` ON `inv_deliveries`
WHEN NEW.photo_content_type IS NOT NULL
	AND NEW.photo_content_type NOT IN ('image/jpeg', 'image/png', 'image/webp')
BEGIN SELECT RAISE(ABORT, 'inventory invoice photo type not allowed'); END;
--> statement-breakpoint
-- Waste: the new columns join the append-only guard, and a Station row names
-- its terminal.
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
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'inv_waste is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_waste_source_valid` BEFORE INSERT ON `inv_waste`
WHEN NEW.source NOT IN ('operator', 'station')
	OR (NEW.source = 'station' AND NEW.device_id IS NULL)
BEGIN SELECT RAISE(ABORT, 'inventory waste source not allowed'); END;
--> statement-breakpoint
-- Orders: who and where never change; status only moves forward; the first
-- send is recorded once; a closed order is final.
CREATE TRIGGER `inv_orders_identity_fixed` BEFORE UPDATE ON `inv_orders`
WHEN NEW.id IS NOT OLD.id
	OR NEW.number IS NOT OLD.number
	OR NEW.client_id IS NOT OLD.client_id
	OR NEW.location_id IS NOT OLD.location_id
	OR NEW.supplier_id IS NOT OLD.supplier_id
	OR NEW.created_by_kind IS NOT OLD.created_by_kind
	OR NEW.created_by_id IS NOT OLD.created_by_id
	OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'inventory order identity is fixed'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_orders_closed_final` BEFORE UPDATE ON `inv_orders`
WHEN OLD.status IN ('received', 'cancelled') AND (
	NEW.status IS NOT OLD.status
	OR NEW.expected_date IS NOT OLD.expected_date
	OR NEW.note IS NOT OLD.note
	OR NEW.currency IS NOT OLD.currency
	OR NEW.sent_at IS NOT OLD.sent_at
	OR NEW.sent_via IS NOT OLD.sent_via
	OR NEW.closed_at IS NOT OLD.closed_at
)
BEGIN SELECT RAISE(ABORT, 'inventory order is closed'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_orders_status_forward` BEFORE UPDATE ON `inv_orders`
WHEN (NEW.status = 'draft' AND OLD.status IS NOT 'draft')
	OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS NOT OLD.sent_at)
	OR (OLD.sent_via IS NOT NULL AND NEW.sent_via IS NOT OLD.sent_via)
BEGIN SELECT RAISE(ABORT, 'inventory order cannot go back'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_orders_no_delete` BEFORE DELETE ON `inv_orders`
WHEN OLD.status IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'inventory order is kept'); END;
--> statement-breakpoint
-- Lines change only while the order is a draft.
CREATE TRIGGER `inv_order_lines_draft_insert` BEFORE INSERT ON `inv_order_lines`
WHEN (SELECT `status` FROM `inv_orders` WHERE `id` = NEW.order_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'inventory order lines are frozen'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_order_lines_draft_update` BEFORE UPDATE ON `inv_order_lines`
WHEN (SELECT `status` FROM `inv_orders` WHERE `id` = OLD.order_id) IS NOT 'draft'
	OR NEW.order_id IS NOT OLD.order_id
BEGIN SELECT RAISE(ABORT, 'inventory order lines are frozen'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_order_lines_draft_delete` BEFORE DELETE ON `inv_order_lines`
WHEN (SELECT `status` FROM `inv_orders` WHERE `id` = OLD.order_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'inventory order lines are frozen'); END;

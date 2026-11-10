CREATE TABLE `inv_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`location_id` text,
	`detail` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_audit_log_actor_kind" CHECK("inv_audit_log"."actor_kind" in ('operator', 'staff', 'system'))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_audit_log_created` ON `inv_audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_audit_log_resource` ON `inv_audit_log` (`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `inv_count_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`count_id` text NOT NULL,
	`item_id` text NOT NULL,
	`area_id` text,
	`quantity` integer NOT NULL,
	`entered_amount` text NOT NULL,
	`entered_unit` text NOT NULL,
	`counter_kind` text NOT NULL,
	`counter_id` text,
	`client_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`count_id`) REFERENCES `inv_counts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`area_id`) REFERENCES `inv_storage_areas`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_count_entries_quantity" CHECK("inv_count_entries"."quantity" >= 0),
	CONSTRAINT "chk_inv_count_entries_counter_kind" CHECK("inv_count_entries"."counter_kind" in ('operator', 'staff', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_count_entries_client` ON `inv_count_entries` (`client_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_count_entries_live` ON `inv_count_entries` (`count_id`,`item_id`,`area_id`,`counter_kind`,`counter_id`,`entered_unit`,`created_at`);--> statement-breakpoint
CREATE TABLE `inv_count_list_items` (
	`list_id` text NOT NULL,
	`item_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`list_id`, `item_id`),
	FOREIGN KEY (`list_id`) REFERENCES `inv_count_lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_inv_count_list_items_item` ON `inv_count_list_items` (`item_id`);--> statement-breakpoint
CREATE TABLE `inv_count_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_count_lists_active_name` ON `inv_count_lists` (`location_id`,lower("name")) WHERE "inv_count_lists"."archived_at" is null;--> statement-breakpoint
CREATE TABLE `inv_counts` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`list_id` text,
	`status` text DEFAULT 'counting' NOT NULL,
	`business_date` text NOT NULL,
	`started_by_kind` text NOT NULL,
	`started_by_id` text,
	`sent_for_review_at` integer,
	`approved_by_id` text,
	`approved_at` integer,
	`cancelled_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `inv_count_lists`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_counts_status" CHECK("inv_counts"."status" in ('counting', 'in_review', 'approved', 'cancelled')),
	CONSTRAINT "chk_inv_counts_started_by_kind" CHECK("inv_counts"."started_by_kind" in ('operator', 'staff', 'system')),
	CONSTRAINT "chk_inv_counts_approved" CHECK("inv_counts"."status" <> 'approved' or "inv_counts"."approved_at" is not null)
);
--> statement-breakpoint
CREATE INDEX `idx_inv_counts_location_status` ON `inv_counts` (`location_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_inv_counts_location_date` ON `inv_counts` (`location_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `inv_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`supplier_id` text,
	`status` text DEFAULT 'received' NOT NULL,
	`invoice_number` text,
	`invoice_date` text,
	`vat_minor` integer,
	`total_minor` integer,
	`currency` text NOT NULL,
	`zatca_reference` text,
	`photo_key` text,
	`paid_at` integer,
	`received_by_kind` text NOT NULL,
	`received_by_id` text,
	`received_at` integer,
	`business_date` text NOT NULL,
	`source` text DEFAULT 'operator' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `inv_suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_deliveries_status" CHECK("inv_deliveries"."status" in ('draft', 'received', 'cancelled')),
	CONSTRAINT "chk_inv_deliveries_source" CHECK("inv_deliveries"."source" in ('operator', 'station')),
	CONSTRAINT "chk_inv_deliveries_received_by_kind" CHECK("inv_deliveries"."received_by_kind" in ('operator', 'staff', 'system')),
	CONSTRAINT "chk_inv_deliveries_money" CHECK(("inv_deliveries"."vat_minor" is null or "inv_deliveries"."vat_minor" >= 0) and ("inv_deliveries"."total_minor" is null or "inv_deliveries"."total_minor" >= 0))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_deliveries_location_received` ON `inv_deliveries` (`location_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_deliveries_location_date` ON `inv_deliveries` (`location_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_inv_deliveries_supplier_paid` ON `inv_deliveries` (`supplier_id`,`paid_at`);--> statement-breakpoint
CREATE TABLE `inv_delivery_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`item_id` text NOT NULL,
	`supplier_product_id` text,
	`quantity` integer NOT NULL,
	`pack_name` text,
	`pack_base_quantity` integer,
	`packs` integer,
	`price_minor` integer,
	`line_total_minor` integer NOT NULL,
	`real_weight_quantity` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `inv_deliveries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_product_id`) REFERENCES `inv_supplier_products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_delivery_lines_amounts" CHECK("inv_delivery_lines"."quantity" >= 0 and "inv_delivery_lines"."line_total_minor" >= 0 and ("inv_delivery_lines"."price_minor" is null or "inv_delivery_lines"."price_minor" >= 0) and ("inv_delivery_lines"."packs" is null or "inv_delivery_lines"."packs" >= 0) and ("inv_delivery_lines"."pack_base_quantity" is null or "inv_delivery_lines"."pack_base_quantity" > 0) and ("inv_delivery_lines"."real_weight_quantity" is null or "inv_delivery_lines"."real_weight_quantity" >= 0))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_delivery_lines_delivery` ON `inv_delivery_lines` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_delivery_lines_item_created` ON `inv_delivery_lines` (`item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `inv_idempotency_keys` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status_code` integer NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idx_inv_idempotency_keys_expires` ON `inv_idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `inv_item_costs` (
	`item_id` text PRIMARY KEY NOT NULL,
	`currency` text NOT NULL,
	`last_cost_micro` integer,
	`last_priced_at` integer,
	`avg_cost_micro` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_item_costs_non_negative" CHECK(("inv_item_costs"."last_cost_micro" is null or "inv_item_costs"."last_cost_micro" >= 0) and ("inv_item_costs"."avg_cost_micro" is null or "inv_item_costs"."avg_cost_micro" >= 0))
);
--> statement-breakpoint
CREATE TABLE `inv_item_place_areas` (
	`item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`area_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`item_id`, `location_id`, `area_id`),
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`area_id`) REFERENCES `inv_storage_areas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_inv_item_place_areas_area` ON `inv_item_place_areas` (`location_id`,`area_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `inv_item_places` (
	`item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`count_unit` text,
	`order_below_quantity` integer,
	`fill_up_to_quantity` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`item_id`, `location_id`),
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_item_places_levels" CHECK(("inv_item_places"."order_below_quantity" is null or "inv_item_places"."order_below_quantity" >= 0) and ("inv_item_places"."fill_up_to_quantity" is null or "inv_item_places"."fill_up_to_quantity" >= 0))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_item_places_location` ON `inv_item_places` (`location_id`);--> statement-breakpoint
CREATE TABLE `inv_item_units` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`name` text NOT NULL,
	`base_quantity` integer NOT NULL,
	`archived_at` integer,
	`used_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_item_units_size" CHECK("inv_item_units"."base_quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_item_units_active_name` ON `inv_item_units` (`item_id`,lower("name")) WHERE "inv_item_units"."archived_at" is null;--> statement-breakpoint
CREATE TABLE `inv_items` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`kind` text DEFAULT 'bought' NOT NULL,
	`base_unit` text NOT NULL,
	`notes` text,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_items_kind" CHECK("inv_items"."kind" in ('bought', 'made')),
	CONSTRAINT "chk_inv_items_base_unit" CHECK("inv_items"."base_unit" in ('g', 'ml', 'piece'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_items_active_name` ON `inv_items` (lower("name")) WHERE "inv_items"."archived_at" is null;--> statement-breakpoint
CREATE INDEX `idx_inv_items_category` ON `inv_items` (`category`);--> statement-breakpoint
CREATE TABLE `inv_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`value_minor` integer,
	`currency` text,
	`kind` text NOT NULL,
	`reason` text,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`event_key` text,
	`business_date` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`note` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_movements_kind" CHECK("inv_movements"."kind" in ('delivery', 'sale', 'waste', 'count', 'adjustment', 'batch_made', 'batch_used', 'transfer_in', 'transfer_out')),
	CONSTRAINT "chk_inv_movements_actor_kind" CHECK("inv_movements"."actor_kind" in ('operator', 'staff', 'system')),
	CONSTRAINT "chk_inv_movements_value_currency" CHECK("inv_movements"."value_minor" is null or "inv_movements"."currency" is not null)
);
--> statement-breakpoint
CREATE INDEX `idx_inv_movements_location_item_created` ON `inv_movements` (`location_id`,`item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_movements_source` ON `inv_movements` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_movements_item_created` ON `inv_movements` (`item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_inv_movements_location_date` ON `inv_movements` (`location_id`,`business_date`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_movements_event_key` ON `inv_movements` (`event_key`) WHERE "inv_movements"."event_key" is not null;--> statement-breakpoint
CREATE TABLE `inv_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`target_food_cost_bp` integer DEFAULT 3000 NOT NULL,
	`unit_system` text NOT NULL,
	`count_day_of_week` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_settings_singleton" CHECK("inv_settings"."id" = 'default'),
	CONSTRAINT "chk_inv_settings_target" CHECK("inv_settings"."target_food_cost_bp" between 0 and 10000),
	CONSTRAINT "chk_inv_settings_unit_system" CHECK("inv_settings"."unit_system" in ('metric', 'us')),
	CONSTRAINT "chk_inv_settings_count_day" CHECK("inv_settings"."count_day_of_week" is null or "inv_settings"."count_day_of_week" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE `inv_storage_areas` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_storage_areas_active_name` ON `inv_storage_areas` (`location_id`,lower("name")) WHERE "inv_storage_areas"."archived_at" is null;--> statement-breakpoint
CREATE INDEX `idx_inv_storage_areas_location` ON `inv_storage_areas` (`location_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `inv_supplier_products` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`item_id` text NOT NULL,
	`pack_name` text NOT NULL,
	`pack_base_quantity` integer NOT NULL,
	`price_minor` integer,
	`currency` text,
	`priced_by_weight` integer DEFAULT false NOT NULL,
	`sku` text,
	`preferred` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `inv_suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_supplier_products_pack" CHECK("inv_supplier_products"."pack_base_quantity" > 0),
	CONSTRAINT "chk_inv_supplier_products_price" CHECK("inv_supplier_products"."price_minor" is null or ("inv_supplier_products"."price_minor" >= 0 and "inv_supplier_products"."currency" is not null))
);
--> statement-breakpoint
CREATE INDEX `idx_inv_supplier_products_item` ON `inv_supplier_products` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_inv_supplier_products_supplier` ON `inv_supplier_products` (`supplier_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_supplier_products_preferred` ON `inv_supplier_products` (`item_id`) WHERE "inv_supplier_products"."preferred" = 1 and "inv_supplier_products"."archived_at" is null;--> statement-breakpoint
CREATE TABLE `inv_suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`contact_name` text,
	`phone` text,
	`email` text,
	`order_channel` text DEFAULT 'email' NOT NULL,
	`delivery_days` text DEFAULT '[]' NOT NULL,
	`cutoff_time` text,
	`cutoff_days_before` integer DEFAULT 1 NOT NULL,
	`minimum_order_minor` integer,
	`currency` text,
	`payment_terms` text,
	`vat_number` text,
	`notes` text,
	`archived_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_inv_suppliers_order_channel" CHECK("inv_suppliers"."order_channel" in ('email', 'whatsapp', 'phone', 'other')),
	CONSTRAINT "chk_inv_suppliers_minimum" CHECK("inv_suppliers"."minimum_order_minor" is null or ("inv_suppliers"."minimum_order_minor" >= 0 and "inv_suppliers"."currency" is not null)),
	CONSTRAINT "chk_inv_suppliers_cutoff_days" CHECK("inv_suppliers"."cutoff_days_before" between 0 and 14),
	CONSTRAINT "chk_inv_suppliers_delivery_days" CHECK(json_valid("inv_suppliers"."delivery_days"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_suppliers_active_name` ON `inv_suppliers` (lower("name")) WHERE "inv_suppliers"."archived_at" is null;--> statement-breakpoint
CREATE TABLE `inv_waste` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`item_id` text,
	`dish_ref` text,
	`quantity` integer NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`value_minor` integer,
	`currency` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`client_id` text NOT NULL,
	`reverses_id` text,
	`business_date` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inv_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reverses_id`) REFERENCES `inv_waste`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inv_waste_reason" CHECK("inv_waste"."reason" in ('expired', 'spoiled', 'over_prepped', 'dropped', 'returned', 'staff_meal', 'cancelled_after_cooking', 'remade_at_till', 'other')),
	CONSTRAINT "chk_inv_waste_actor_kind" CHECK("inv_waste"."actor_kind" in ('operator', 'staff', 'system')),
	CONSTRAINT "chk_inv_waste_what" CHECK("inv_waste"."item_id" is not null or "inv_waste"."dish_ref" is not null),
	CONSTRAINT "chk_inv_waste_quantity" CHECK("inv_waste"."quantity" > 0),
	CONSTRAINT "chk_inv_waste_value" CHECK("inv_waste"."value_minor" is null or ("inv_waste"."value_minor" >= 0 and "inv_waste"."currency" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_waste_client` ON `inv_waste` (`client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inv_waste_reverses` ON `inv_waste` (`reverses_id`) WHERE "inv_waste"."reverses_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_inv_waste_location_date` ON `inv_waste` (`location_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_inv_waste_item_created` ON `inv_waste` (`item_id`,`created_at`);
--> statement-breakpoint
CREATE TRIGGER `inv_items_base_unit_fixed` BEFORE UPDATE OF `base_unit` ON `inv_items`
WHEN NEW.base_unit IS NOT OLD.base_unit AND EXISTS (SELECT 1 FROM `inv_movements` WHERE `item_id` = OLD.id)
BEGIN SELECT RAISE(ABORT, 'inventory item unit is fixed'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_item_units_size_fixed` BEFORE UPDATE ON `inv_item_units`
WHEN OLD.used_at IS NOT NULL AND (
	NEW.base_quantity IS NOT OLD.base_quantity
	OR NEW.item_id IS NOT OLD.item_id
	OR NEW.used_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'inventory unit in use'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_counts_closed_final` BEFORE UPDATE ON `inv_counts`
WHEN OLD.status IN ('approved', 'cancelled') AND (
	NEW.status IS NOT OLD.status
	OR NEW.location_id IS NOT OLD.location_id
	OR NEW.business_date IS NOT OLD.business_date
	OR NEW.approved_at IS NOT OLD.approved_at
	OR NEW.approved_by_id IS NOT OLD.approved_by_id
)
BEGIN SELECT RAISE(ABORT, 'inventory count is closed'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_movements_no_delete` BEFORE DELETE ON `inv_movements`
BEGIN SELECT RAISE(ABORT, 'inv_movements is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_movements_no_update` BEFORE UPDATE ON `inv_movements`
WHEN NOT (
	NEW.note IS NULL
	AND NEW.id IS OLD.id
	AND NEW.location_id IS OLD.location_id
	AND NEW.item_id IS OLD.item_id
	AND NEW.quantity IS OLD.quantity
	AND NEW.value_minor IS OLD.value_minor
	AND NEW.currency IS OLD.currency
	AND NEW.kind IS OLD.kind
	AND NEW.reason IS OLD.reason
	AND NEW.source_type IS OLD.source_type
	AND NEW.source_id IS OLD.source_id
	AND NEW.event_key IS OLD.event_key
	AND NEW.business_date IS OLD.business_date
	AND NEW.actor_kind IS OLD.actor_kind
	AND NEW.actor_id IS OLD.actor_id
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'inv_movements is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_count_entries_no_delete` BEFORE DELETE ON `inv_count_entries`
BEGIN SELECT RAISE(ABORT, 'inv_count_entries is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_count_entries_no_update` BEFORE UPDATE ON `inv_count_entries`
BEGIN SELECT RAISE(ABORT, 'inv_count_entries is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_count_entries_open_count` BEFORE INSERT ON `inv_count_entries`
WHEN (SELECT `status` FROM `inv_counts` WHERE `id` = NEW.count_id) IS NOT 'counting'
	AND (SELECT `status` FROM `inv_counts` WHERE `id` = NEW.count_id) IS NOT 'in_review'
BEGIN SELECT RAISE(ABORT, 'inventory count is closed'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_delivery_lines_no_delete` BEFORE DELETE ON `inv_delivery_lines`
BEGIN SELECT RAISE(ABORT, 'inv_delivery_lines is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_delivery_lines_no_update` BEFORE UPDATE ON `inv_delivery_lines`
BEGIN SELECT RAISE(ABORT, 'inv_delivery_lines is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_waste_no_delete` BEFORE DELETE ON `inv_waste`
BEGIN SELECT RAISE(ABORT, 'inv_waste is append-only'); END;
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
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'inv_waste is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_waste_reversal_matches` BEFORE INSERT ON `inv_waste`
WHEN NEW.reverses_id IS NOT NULL AND NOT EXISTS (
	SELECT 1 FROM `inv_waste` AS original
	WHERE original.id = NEW.reverses_id
		AND original.reverses_id IS NULL
		AND original.location_id = NEW.location_id
		AND original.item_id IS NEW.item_id
		AND original.dish_ref IS NEW.dish_ref
		AND original.quantity = NEW.quantity
)
BEGIN SELECT RAISE(ABORT, 'inventory waste reversal does not match'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_audit_log_no_delete` BEFORE DELETE ON `inv_audit_log`
BEGIN SELECT RAISE(ABORT, 'inv_audit_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `inv_audit_log_no_update` BEFORE UPDATE ON `inv_audit_log`
BEGIN SELECT RAISE(ABORT, 'inv_audit_log is append-only'); END;

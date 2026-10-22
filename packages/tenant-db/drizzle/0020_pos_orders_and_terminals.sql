CREATE TABLE `pos_cash_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text NOT NULL,
	`staff_id` text,
	`staff_name` text,
	`approved_by_staff_id` text,
	`approved_by_staff_name` text,
	`at` integer NOT NULL,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`shift_id`) REFERENCES `pos_shifts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_pos_cash_movements_shift` ON `pos_cash_movements` (`shift_id`);--> statement-breakpoint
CREATE TABLE `pos_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`terminal_code` text NOT NULL,
	`location_id` text,
	`scope_id` text DEFAULT 'main' NOT NULL,
	`sign_in_required` integer DEFAULT false NOT NULL,
	`sign_in_required_since` integer,
	`day_start_minutes` integer DEFAULT 240 NOT NULL,
	`shifts_required` integer DEFAULT false NOT NULL,
	`secret_hash` text NOT NULL,
	`paired_by` text NOT NULL,
	`paired_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pos_devices_secret_hash` ON `pos_devices` (`secret_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pos_devices_terminal_code` ON `pos_devices` (`terminal_code`) WHERE "pos_devices"."revoked_at" is null;--> statement-breakpoint
CREATE TABLE `pos_fiscal_documents` (
	`doc_id` text PRIMARY KEY NOT NULL,
	`chain_id` text NOT NULL,
	`counter` integer NOT NULL,
	`kind` text NOT NULL,
	`order_id` text NOT NULL,
	`device_id` text NOT NULL,
	`issued_at` integer NOT NULL,
	`currency` text NOT NULL,
	`total_cents` integer NOT NULL,
	`tax_cents` integer NOT NULL,
	`previous_hash` text NOT NULL,
	`hash` text NOT NULL,
	`problem` text,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pos_fiscal_chain_counter` ON `pos_fiscal_documents` (`chain_id`,`counter`);--> statement-breakpoint
CREATE INDEX `idx_pos_fiscal_order` ON `pos_fiscal_documents` (`order_id`);--> statement-breakpoint
CREATE TABLE `pos_held_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`order_id` text,
	`revision` integer,
	`error` text NOT NULL,
	`message` text,
	`contract_version` integer,
	`payload` text NOT NULL,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`resolved_at` integer,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_pos_held_uploads_device` ON `pos_held_uploads` (`device_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_pos_held_uploads_open` ON `pos_held_uploads` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `pos_managers` (
	`staff_id` text PRIMARY KEY NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pos_order_lines` (
	`order_id` text NOT NULL,
	`line_index` integer NOT NULL,
	`item_id` text NOT NULL,
	`name` text NOT NULL,
	`variant_id` text,
	`quantity` integer NOT NULL,
	`unit_cents` integer NOT NULL,
	`total_cents` integer NOT NULL,
	PRIMARY KEY(`order_id`, `line_index`),
	FOREIGN KEY (`order_id`) REFERENCES `pos_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_pos_order_lines_item` ON `pos_order_lines` (`item_id`);--> statement-breakpoint
CREATE TABLE `pos_order_revisions` (
	`order_id` text NOT NULL,
	`revision` integer NOT NULL,
	`device_id` text NOT NULL,
	`review_reason` text,
	`snapshot` text NOT NULL,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`order_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `pos_order_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`from_device_id` text NOT NULL,
	`to_device_id` text NOT NULL,
	`revision` integer NOT NULL,
	`staff_id` text,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pos_order_transfers_from` ON `pos_order_transfers` (`from_device_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_pos_order_transfers_order` ON `pos_order_transfers` (`order_id`);--> statement-breakpoint
CREATE TABLE `pos_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`number` text NOT NULL,
	`business_date` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`order_type` text NOT NULL,
	`order_source` text DEFAULT 'counter' NOT NULL,
	`customer_phone` text,
	`pickup_at` integer,
	`pickup_time_zone` text,
	`guest_name` text,
	`table_label` text,
	`staff_id` text,
	`staff_name` text,
	`sign_in` text,
	`voided_by_staff_id` text,
	`voided_by_staff_name` text,
	`void_reason` text,
	`void_approved_by_staff_id` text,
	`void_approved_by_staff_name` text,
	`location_id` text NOT NULL,
	`location_name` text,
	`currency` text NOT NULL,
	`tax_rate_percent` real,
	`tax_inclusive` integer DEFAULT false NOT NULL,
	`subtotal_cents` integer NOT NULL,
	`adjustment_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer NOT NULL,
	`tip_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer NOT NULL,
	`refunded_cents` integer DEFAULT 0 NOT NULL,
	`server_total_cents` integer,
	`review_reason` text,
	`lines` text NOT NULL,
	`line_voids` text DEFAULT '[]' NOT NULL,
	`adjustments` text NOT NULL,
	`catalog_fetched_at` integer,
	`shift_id` text,
	`rung_up_at` integer NOT NULL,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`paid_at` integer,
	`voided_at` integer,
	`refunded_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `pos_devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pos_orders_device_day_number` ON `pos_orders` (`device_id`,`business_date`,`number`);--> statement-breakpoint
CREATE INDEX `idx_pos_orders_status_rung_up` ON `pos_orders` (`status`,`rung_up_at`);--> statement-breakpoint
CREATE INDEX `idx_pos_orders_business_date` ON `pos_orders` (`business_date`,`location_id`);--> statement-breakpoint
CREATE INDEX `idx_pos_orders_review` ON `pos_orders` (`review_reason`);--> statement-breakpoint
CREATE INDEX `idx_pos_orders_guest_name` ON `pos_orders` (`updated_at`) WHERE "pos_orders"."guest_name" is not null;--> statement-breakpoint
CREATE TABLE `pos_pairing_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`label` text NOT NULL,
	`terminal_code` text NOT NULL,
	`location_id` text,
	`scope_id` text DEFAULT 'main' NOT NULL,
	`sign_in_required` integer DEFAULT false NOT NULL,
	`day_start_minutes` integer DEFAULT 240 NOT NULL,
	`shifts_required` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`device_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_pos_pairing_codes_hash` ON `pos_pairing_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `pos_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`device_id` text NOT NULL,
	`kind` text DEFAULT 'payment' NOT NULL,
	`refund_of` text,
	`staff_id` text,
	`staff_name` text,
	`approved_by_staff_id` text,
	`approved_by_staff_name` text,
	`reason` text,
	`method` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`tendered_cents` integer NOT NULL,
	`reference` text,
	`shift_id` text,
	`paid_at` integer NOT NULL,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `pos_orders`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_pos_payments_order` ON `pos_payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_pos_payments_paid_at` ON `pos_payments` (`paid_at`);--> statement-breakpoint
CREATE INDEX `idx_pos_payments_shift` ON `pos_payments` (`shift_id`);--> statement-breakpoint
CREATE TABLE `pos_pin_attempts` (
	`device_id` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer,
	`blocked_until` integer,
	`hour_started_at` integer,
	`hour_failures` integer DEFAULT 0 NOT NULL,
	`hour_alerted_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `pos_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pos_shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`business_date` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`opened_at` integer NOT NULL,
	`opened_by_staff_id` text,
	`opened_by_staff_name` text,
	`opening_float_cents` integer NOT NULL,
	`closed_at` integer,
	`closed_by_staff_id` text,
	`closed_by_staff_name` text,
	`counted_cash_cents` integer,
	`expected_cash_cents` integer,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pos_shifts_device_opened` ON `pos_shifts` (`device_id`,`opened_at`);--> statement-breakpoint
CREATE INDEX `idx_pos_shifts_business_date` ON `pos_shifts` (`business_date`);--> statement-breakpoint
CREATE TABLE `pos_zatca_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`environment` text NOT NULL,
	`seller_name` text NOT NULL,
	`vat_number` text NOT NULL,
	`cr_number` text NOT NULL,
	`street` text NOT NULL,
	`building_number` text NOT NULL,
	`district` text NOT NULL,
	`city` text NOT NULL,
	`postal_code` text NOT NULL,
	`business_category` text NOT NULL,
	`branch_name` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pos_zatca_submissions` (
	`doc_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`counter` integer NOT NULL,
	`uuid` text NOT NULL,
	`invoice_hash` text NOT NULL,
	`xml_base64` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`response` text,
	`last_error` text,
	`issued_at` integer NOT NULL,
	`reported_at` integer,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pos_zatca_submissions_due` ON `pos_zatca_submissions` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `pos_zatca_units` (
	`device_id` text PRIMARY KEY NOT NULL,
	`environment` text NOT NULL,
	`status` text NOT NULL,
	`private_key_sealed` text NOT NULL,
	`compliance_request_id` text,
	`compliance_token` text,
	`compliance_secret_sealed` text,
	`production_token` text,
	`production_secret_sealed` text,
	`last_error` text,
	`onboarded_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `pos_devices`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
-- Append-only money and history. drizzle-kit does not model triggers, so they
-- are part of this migration by hand; the schema tests assert each one.
-- A payment or refund row never changes, except that erasing a person may
-- replace the staff names on it.
CREATE TRIGGER `pos_payments_no_update` BEFORE UPDATE ON `pos_payments`
WHEN NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`order_id` IS OLD.`order_id`
	AND NEW.`device_id` IS OLD.`device_id`
	AND NEW.`kind` IS OLD.`kind`
	AND NEW.`refund_of` IS OLD.`refund_of`
	AND NEW.`staff_id` IS OLD.`staff_id`
	AND NEW.`approved_by_staff_id` IS OLD.`approved_by_staff_id`
	AND NEW.`reason` IS OLD.`reason`
	AND NEW.`method` IS OLD.`method`
	AND NEW.`amount_cents` IS OLD.`amount_cents`
	AND NEW.`tendered_cents` IS OLD.`tendered_cents`
	AND NEW.`reference` IS OLD.`reference`
	AND NEW.`shift_id` IS OLD.`shift_id`
	AND NEW.`paid_at` IS OLD.`paid_at`
	AND NEW.`received_at` IS OLD.`received_at`
)
BEGIN
	SELECT RAISE(ABORT, 'pos_payments is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_payments_no_delete` BEFORE DELETE ON `pos_payments`
BEGIN
	SELECT RAISE(ABORT, 'pos_payments is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_order_revisions_no_update` BEFORE UPDATE ON `pos_order_revisions`
BEGIN
	SELECT RAISE(ABORT, 'pos_order_revisions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_order_revisions_no_delete` BEFORE DELETE ON `pos_order_revisions`
BEGIN
	SELECT RAISE(ABORT, 'pos_order_revisions is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_fiscal_documents_no_update` BEFORE UPDATE ON `pos_fiscal_documents`
BEGIN
	SELECT RAISE(ABORT, 'pos_fiscal_documents is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_fiscal_documents_no_delete` BEFORE DELETE ON `pos_fiscal_documents`
BEGIN
	SELECT RAISE(ABORT, 'pos_fiscal_documents is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_cash_movements_no_update` BEFORE UPDATE ON `pos_cash_movements`
WHEN NOT (
	NEW.`id` IS OLD.`id`
	AND NEW.`shift_id` IS OLD.`shift_id`
	AND NEW.`kind` IS OLD.`kind`
	AND NEW.`amount_cents` IS OLD.`amount_cents`
	AND NEW.`note` IS OLD.`note`
	AND NEW.`staff_id` IS OLD.`staff_id`
	AND NEW.`approved_by_staff_id` IS OLD.`approved_by_staff_id`
	AND NEW.`at` IS OLD.`at`
	AND NEW.`received_at` IS OLD.`received_at`
)
BEGIN
	SELECT RAISE(ABORT, 'pos_cash_movements is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_cash_movements_no_delete` BEFORE DELETE ON `pos_cash_movements`
BEGIN
	SELECT RAISE(ABORT, 'pos_cash_movements is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_shifts_no_delete` BEFORE DELETE ON `pos_shifts`
BEGIN
	SELECT RAISE(ABORT, 'pos_shifts are kept');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_zatca_submissions_no_delete` BEFORE DELETE ON `pos_zatca_submissions`
BEGIN
	SELECT RAISE(ABORT, 'pos_zatca_submissions are kept');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_zatca_submissions_document_fixed` BEFORE UPDATE ON `pos_zatca_submissions`
WHEN NOT (
	NEW.`doc_id` IS OLD.`doc_id`
	AND NEW.`uuid` IS OLD.`uuid`
	AND NEW.`invoice_hash` IS OLD.`invoice_hash`
	AND NEW.`xml_base64` IS OLD.`xml_base64`
	AND NEW.`counter` IS OLD.`counter`
)
BEGIN
	SELECT RAISE(ABORT, 'a signed document cannot change');
END;
--> statement-breakpoint
CREATE TRIGGER `pos_orders_no_delete` BEFORE DELETE ON `pos_orders`
BEGIN
	SELECT RAISE(ABORT, 'pos_orders are kept');
END;

CREATE TABLE `gift_card_attempts` (
	`bucket` text NOT NULL,
	`subject_hash` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`bucket`, `subject_hash`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `idx_gift_card_attempts_window` ON `gift_card_attempts` (`window_start`);--> statement-breakpoint
CREATE TABLE `gift_card_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`count` integer NOT NULL,
	`print_order_ref` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_gift_card_batches_count" CHECK("gift_card_batches"."count" between 1 and 1000)
);
--> statement-breakpoint
CREATE INDEX `idx_gift_card_batches_location` ON `gift_card_batches` (`location_id`);--> statement-breakpoint
CREATE TABLE `gift_card_idempotency_keys` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status_code` integer NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`card_id` text,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idx_gift_card_idempotency_keys_expires` ON `gift_card_idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_idempotency_keys_card` ON `gift_card_idempotency_keys` (`card_id`);--> statement-breakpoint
CREATE TABLE `gift_card_import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`actor_name` text,
	`status` text DEFAULT 'running' NOT NULL,
	`counts` text DEFAULT '{}' NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`finished_at` integer,
	CONSTRAINT "chk_gift_card_import_runs_json" CHECK(json_valid("gift_card_import_runs"."counts"))
);
--> statement-breakpoint
CREATE TABLE `gift_card_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text,
	`channel` text NOT NULL,
	`location_id` text,
	`actor_id` text,
	`actor_name` text,
	`reason` text,
	`note` text,
	`ref_entry_id` text,
	`idempotency_key` text NOT NULL,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `gift_cards`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_gift_card_ledger_kind" CHECK("gift_card_ledger"."kind" in ('issue', 'top_up', 'redeem', 'refund', 'adjust', 'void', 'import', 'dispute_removal')),
	CONSTRAINT "chk_gift_card_ledger_channel" CHECK("gift_card_ledger"."channel" in ('online', 'pos', 'app', 'import', 'system')),
	CONSTRAINT "chk_gift_card_ledger_source_type" CHECK("gift_card_ledger"."source_type" in ('restaurant_order', 'pos_order', 'purchase', 'adjust', 'import', 'manual_charge', 'system')),
	CONSTRAINT "chk_gift_card_ledger_sign" CHECK(("gift_card_ledger"."kind" in ('issue', 'top_up', 'refund') and "gift_card_ledger"."amount_minor" > 0) or ("gift_card_ledger"."kind" = 'import' and "gift_card_ledger"."amount_minor" >= 0) or ("gift_card_ledger"."kind" in ('redeem', 'void', 'dispute_removal') and "gift_card_ledger"."amount_minor" < 0) or ("gift_card_ledger"."kind" = 'adjust' and "gift_card_ledger"."amount_minor" <> 0)),
	CONSTRAINT "chk_gift_card_ledger_adjust_reason" CHECK("gift_card_ledger"."kind" <> 'adjust' or "gift_card_ledger"."reason" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gift_card_ledger_idempotency_unique` ON `gift_card_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_ledger_card_at` ON `gift_card_ledger` (`card_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_ledger_source` ON `gift_card_ledger` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_ledger_location_at` ON `gift_card_ledger` (`location_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_ledger_kind_at` ON `gift_card_ledger` (`kind`,`at`);--> statement-breakpoint
CREATE TABLE `gift_card_purchase_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text,
	`payment_hash` text,
	`email_hash` text,
	`device_hash` text,
	`amount_minor` integer NOT NULL,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `gift_cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_gift_card_purchase_attempts_at` ON `gift_card_purchase_attempts` (`at`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_purchase_attempts_payment` ON `gift_card_purchase_attempts` (`payment_hash`,`at`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_purchase_attempts_email` ON `gift_card_purchase_attempts` (`email_hash`,`at`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_purchase_attempts_device` ON `gift_card_purchase_attempts` (`device_hash`,`at`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_purchase_attempts_card` ON `gift_card_purchase_attempts` (`card_id`);--> statement-breakpoint
CREATE TABLE `gift_card_show_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `gift_cards`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_gift_card_show_tokens_expires` ON `gift_card_show_tokens` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_gift_card_show_tokens_card` ON `gift_card_show_tokens` (`card_id`);--> statement-breakpoint
CREATE TABLE `gift_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text,
	`last4` text NOT NULL,
	`external_number_hash` text,
	`external_last4` text,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`expires_at` integer,
	`location_id` text,
	`batch_id` text,
	`batch_seq` integer,
	`design_key` text,
	`purchaser_customer_id` text,
	`purchaser_name` text,
	`purchaser_email` text,
	`recipient_name` text,
	`recipient_email` text,
	`sender_name` text,
	`message` text,
	`send_to_self` integer DEFAULT false NOT NULL,
	`deliver_at` integer,
	`delivered_at` integer,
	`holder_customer_id` text,
	`held_at` integer,
	`hold_until` integer,
	`hold_reason` text,
	`frozen_at` integer,
	`freeze_reason` text,
	`purchase_amount_minor` integer,
	`fee_minor` integer DEFAULT 0 NOT NULL,
	`payment_status` text DEFAULT 'not_required' NOT NULL,
	`payment_processor` text,
	`payment_session_id` text,
	`payment_id` text,
	`payment_token_hash` text,
	`payment_event_at` integer,
	`payment_hold_expires_at` integer,
	`paid_at` integer,
	`activated_at` integer,
	`last_used_at` integer,
	`import_run_id` text,
	`erased_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `gift_card_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchaser_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`holder_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_run_id`) REFERENCES `gift_card_import_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_gift_cards_status" CHECK("gift_cards"."status" in ('pending', 'inactive', 'active', 'held', 'frozen', 'voided', 'expired')),
	CONSTRAINT "chk_gift_cards_source" CHECK("gift_cards"."source" in ('online', 'pos', 'import', 'print')),
	CONSTRAINT "chk_gift_cards_number" CHECK("gift_cards"."code_hash" is not null or "gift_cards"."external_number_hash" is not null),
	CONSTRAINT "chk_gift_cards_fee" CHECK("gift_cards"."fee_minor" >= 0),
	CONSTRAINT "chk_gift_cards_payment_status" CHECK("gift_cards"."payment_status" in ('not_required', 'unpaid', 'pending', 'paid', 'failed', 'expired', 'review'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gift_cards_code_hash_unique` ON `gift_cards` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `gift_cards_external_hash_unique` ON `gift_cards` (`external_number_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `gift_cards_batch_seq_unique` ON `gift_cards` (`batch_id`,`batch_seq`);--> statement-breakpoint
CREATE INDEX `idx_gift_cards_status` ON `gift_cards` (`status`);--> statement-breakpoint
CREATE INDEX `idx_gift_cards_location` ON `gift_cards` (`location_id`);--> statement-breakpoint
CREATE INDEX `idx_gift_cards_holder` ON `gift_cards` (`holder_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_gift_cards_purchaser` ON `gift_cards` (`purchaser_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_gift_cards_deliver` ON `gift_cards` (`deliver_at`);--> statement-breakpoint
CREATE INDEX `idx_gift_cards_hold_until` ON `gift_cards` (`hold_until`);--> statement-breakpoint
CREATE INDEX `idx_gift_cards_created` ON `gift_cards` (`created_at`);--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `gift_card_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TRIGGER `gift_card_ledger_no_delete` BEFORE DELETE ON `gift_card_ledger`
BEGIN SELECT RAISE(ABORT, 'gift_card_ledger rows are kept'); END;
--> statement-breakpoint
CREATE TRIGGER `gift_card_ledger_facts_fixed` BEFORE UPDATE ON `gift_card_ledger`
WHEN NEW.id IS NOT OLD.id
	OR NEW.card_id IS NOT OLD.card_id
	OR NEW.kind IS NOT OLD.kind
	OR NEW.amount_minor IS NOT OLD.amount_minor
	OR NEW.source_type IS NOT OLD.source_type
	OR NEW.source_id IS NOT OLD.source_id
	OR NEW.channel IS NOT OLD.channel
	OR NEW.location_id IS NOT OLD.location_id
	OR NEW.actor_id IS NOT OLD.actor_id
	OR NEW.reason IS NOT OLD.reason
	OR NEW.ref_entry_id IS NOT OLD.ref_entry_id
	OR NEW.idempotency_key IS NOT OLD.idempotency_key
	OR NEW.at IS NOT OLD.at
BEGIN SELECT RAISE(ABORT, 'gift_card_ledger facts are fixed'); END;
--> statement-breakpoint
CREATE TRIGGER `gift_card_ledger_never_negative` BEFORE INSERT ON `gift_card_ledger`
WHEN NEW.amount_minor < 0
	AND (SELECT COALESCE(SUM(amount_minor), 0) FROM gift_card_ledger WHERE card_id = NEW.card_id) + NEW.amount_minor < 0
BEGIN SELECT RAISE(ABORT, 'gift card balance would go negative'); END;
--> statement-breakpoint
CREATE TRIGGER `gift_card_ledger_redeem_needs_active` BEFORE INSERT ON `gift_card_ledger`
WHEN NEW.kind = 'redeem'
	AND (SELECT status FROM gift_cards WHERE id = NEW.card_id) IS NOT 'active'
BEGIN SELECT RAISE(ABORT, 'gift card is not active'); END;
--> statement-breakpoint
CREATE TRIGGER `gift_card_ledger_refund_within_redeem` BEFORE INSERT ON `gift_card_ledger`
WHEN NEW.kind = 'refund' AND NEW.ref_entry_id IS NOT NULL
	AND (SELECT -amount_minor FROM gift_card_ledger WHERE id = NEW.ref_entry_id AND kind = 'redeem')
		< (SELECT COALESCE(SUM(amount_minor), 0) FROM gift_card_ledger WHERE ref_entry_id = NEW.ref_entry_id AND kind = 'refund') + NEW.amount_minor
BEGIN SELECT RAISE(ABORT, 'gift card refund exceeds charge'); END;

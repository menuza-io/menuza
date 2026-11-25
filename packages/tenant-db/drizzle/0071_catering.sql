CREATE TABLE `catering_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text DEFAULT 'balance' NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`processor` text,
	`session_id` text,
	`payment_id` text,
	`balance_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`paid_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_catering_payments_amount" CHECK("catering_payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catering_payments_session_unique` ON `catering_payments` (`session_id`) WHERE "catering_payments"."session_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_catering_payments_order` ON `catering_payments` (`order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `catering_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`customer_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`source` text DEFAULT 'operator' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`currency` text NOT NULL,
	`fulfillment` text DEFAULT 'pickup' NOT NULL,
	`event_at` integer,
	`guest_count` integer,
	`contact_name` text DEFAULT '' NOT NULL,
	`contact_phone` text DEFAULT '' NOT NULL,
	`contact_email` text,
	`delivery` text,
	`event_notes` text,
	`quote_note` text,
	`lines` text DEFAULT '[]' NOT NULL,
	`charges` text DEFAULT '[]' NOT NULL,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`tax_rate_bp` integer DEFAULT 0 NOT NULL,
	`tax_inclusive` integer DEFAULT false NOT NULL,
	`deposit_percent` integer,
	`valid_days` integer,
	`expires_at` integer,
	`created_by` text,
	`sent_at` integer,
	`paid_at` integer,
	`paid_order_id` text,
	`payment_session_id` text,
	`payment_processor` text,
	`payment_id` text,
	`payment_event_at` integer,
	`idempotency_key` text,
	`request_hash` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_catering_quotes_status" CHECK("catering_quotes"."status" in ('draft', 'sent', 'accepted', 'paid', 'expired', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catering_quotes_idempotency_unique` ON `catering_quotes` (`idempotency_key`) WHERE "catering_quotes"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `catering_quotes_payment_session_unique` ON `catering_quotes` (`payment_session_id`) WHERE "catering_quotes"."payment_session_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_catering_quotes_status` ON `catering_quotes` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_catering_quotes_location` ON `catering_quotes` (`location_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `is_catering` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `catering_event_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `guest_count` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `catering_notes` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `catering_quote_id` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `paid_cents` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `deposit_percent` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `deposit_cents` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `balance_due_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `balance_state` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `balance_paid_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `balance_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `balance_before_due_sent_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `balance_overdue_sent_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `event_alert_sent_at` integer;--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_catering_event` ON `restaurant_orders` (`catering_event_at`) WHERE "restaurant_orders"."is_catering" = 1;
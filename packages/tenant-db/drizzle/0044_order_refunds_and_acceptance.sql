CREATE TABLE `qr_tab_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`tab_id` text NOT NULL,
	`tab_payment_id` text,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`full` integer DEFAULT false NOT NULL,
	`note` text,
	`actor_id` text NOT NULL,
	`origin` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`processor` text NOT NULL,
	`session_id` text NOT NULL,
	`provider_refund_id` text,
	`failure_code` text,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`settled_at` integer,
	`updated_at` integer,
	`reversed_at` integer,
	`reversal_code` text,
	FOREIGN KEY (`tab_id`) REFERENCES `qr_tabs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tab_payment_id`) REFERENCES `qr_tab_payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_qr_tab_refunds_amount" CHECK("qr_tab_refunds"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qr_tab_refunds_idempotency_unique` ON `qr_tab_refunds` (`tab_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `qr_tab_refunds_one_pending` ON `qr_tab_refunds` (`tab_id`) WHERE "qr_tab_refunds"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `qr_tab_refunds_provider_refund_unique` ON `qr_tab_refunds` (`provider_refund_id`) WHERE "qr_tab_refunds"."provider_refund_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_qr_tab_refunds_tab` ON `qr_tab_refunds` (`tab_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_qr_tab_refunds_pending` ON `qr_tab_refunds` (`created_at`) WHERE "qr_tab_refunds"."status" = 'pending';--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `disputed_at` integer;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `dispute_status` text;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `kind` text DEFAULT 'record' NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `status` text DEFAULT 'succeeded' NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `origin` text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `processor` text;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `provider_refund_id` text;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `failure_code` text;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `settled_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `reversed_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_order_refunds` ADD `reversal_code` text;--> statement-breakpoint
CREATE UNIQUE INDEX `restaurant_order_refunds_one_pending` ON `restaurant_order_refunds` (`order_id`) WHERE "restaurant_order_refunds"."kind" = 'provider' and "restaurant_order_refunds"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `restaurant_order_refunds_provider_refund_unique` ON `restaurant_order_refunds` (`provider_refund_id`) WHERE "restaurant_order_refunds"."provider_refund_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_restaurant_order_refunds_pending` ON `restaurant_order_refunds` (`created_at`) WHERE "restaurant_order_refunds"."status" = 'pending';--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `payment_id` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `cancel_reason` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `cancelled_by` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `acceptance_deadline_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `accepted_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `rejected_reason` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `disputed_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `dispute_status` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `refund_reversed_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `cancel_refund_due_at` integer;--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_acceptance_deadline` ON `restaurant_orders` (`acceptance_deadline_at`) WHERE "restaurant_orders"."status" = 'pending_acceptance';--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_cancel_refund_due` ON `restaurant_orders` (`cancel_refund_due_at`) WHERE "restaurant_orders"."cancel_refund_due_at" is not null;--> statement-breakpoint
DROP TRIGGER IF EXISTS `restaurant_orders_refunded_cents_guard`;
--> statement-breakpoint
CREATE TRIGGER `restaurant_orders_refunded_cents_guard` BEFORE UPDATE OF `refunded_cents`, `refund_reversed_cents` ON `restaurant_orders`
WHEN NEW.refunded_cents < OLD.refunded_cents
	OR NEW.refund_reversed_cents < OLD.refund_reversed_cents
	OR NEW.refund_reversed_cents > NEW.refunded_cents
	OR NEW.refunded_cents - NEW.refund_reversed_cents > NEW.total_cents
BEGIN SELECT RAISE(ABORT, 'restaurant_orders refunds only add up to the total'); END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `restaurant_order_refunds_no_update`;
--> statement-breakpoint
CREATE TRIGGER `restaurant_order_refunds_valid_insert` BEFORE INSERT ON `restaurant_order_refunds`
WHEN NOT coalesce((
	NEW.kind IN ('record', 'provider')
	AND NEW.origin IN ('operator', 'station', 'guest', 'system')
	AND NEW.reversed_at IS NULL AND NEW.reversal_code IS NULL
	AND (
		(NEW.kind = 'record' AND NEW.status = 'succeeded'
			AND NEW.processor IS NULL AND NEW.session_id IS NULL
			AND NEW.provider_refund_id IS NULL AND NEW.failure_code IS NULL
			AND NEW.settled_at IS NULL)
		OR
		(NEW.kind = 'provider' AND NEW.status = 'pending'
			AND NEW.processor IN ('connect', 'checkout') AND NEW.session_id IS NOT NULL
			AND NEW.failure_code IS NULL AND NEW.settled_at IS NULL)
	)
), 0)
BEGIN SELECT RAISE(ABORT, 'restaurant_order_refunds: invalid new refund'); END;
--> statement-breakpoint
CREATE TRIGGER `restaurant_order_refunds_no_update` BEFORE UPDATE ON `restaurant_order_refunds`
WHEN NOT coalesce((
	NEW.id IS OLD.id
	AND NEW.order_id IS OLD.order_id
	AND NEW.amount_cents IS OLD.amount_cents
	AND NEW.currency IS OLD.currency
	AND NEW.full IS OLD.full
	AND NEW.actor_id IS OLD.actor_id
	AND NEW.idempotency_key IS OLD.idempotency_key
	AND NEW.request_hash IS OLD.request_hash
	AND NEW.created_at IS OLD.created_at
	AND NEW.kind IS OLD.kind
	AND NEW.origin IS OLD.origin
	AND NEW.processor IS OLD.processor
	AND NEW.session_id IS OLD.session_id
	AND (NEW.note IS OLD.note OR NEW.note IS NULL)
	AND (
		(NEW.status IS OLD.status
			AND NEW.provider_refund_id IS OLD.provider_refund_id
			AND NEW.failure_code IS OLD.failure_code
			AND NEW.settled_at IS OLD.settled_at
			AND NEW.reversed_at IS OLD.reversed_at
			AND NEW.reversal_code IS OLD.reversal_code)
		OR
		(OLD.status = 'pending' AND NEW.status = 'pending'
			AND OLD.provider_refund_id IS NULL AND NEW.provider_refund_id IS NOT NULL
			AND NEW.failure_code IS OLD.failure_code
			AND NEW.settled_at IS NULL
			AND NEW.reversed_at IS NULL AND NEW.reversal_code IS NULL)
		OR
		(OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed')
			AND (OLD.provider_refund_id IS NULL OR NEW.provider_refund_id IS OLD.provider_refund_id)
			AND (NEW.status = 'failed' OR NEW.failure_code IS NULL)
			AND NEW.settled_at IS NOT NULL
			AND NEW.reversed_at IS NULL AND NEW.reversal_code IS NULL)
		OR
		(OLD.kind = 'provider' AND OLD.status = 'failed' AND NEW.status = 'succeeded'
			AND NEW.provider_refund_id IS NOT NULL
			AND (OLD.provider_refund_id IS NULL OR NEW.provider_refund_id IS OLD.provider_refund_id)
			AND NEW.failure_code IS NULL
			AND NEW.settled_at IS NOT NULL
			AND OLD.reversed_at IS NULL AND OLD.reversal_code IS NULL
			AND NEW.reversed_at IS NULL AND NEW.reversal_code IS NULL)
		OR
		(OLD.kind = 'provider' AND OLD.status = 'succeeded' AND NEW.status = 'succeeded'
			AND NEW.provider_refund_id IS OLD.provider_refund_id
			AND NEW.failure_code IS OLD.failure_code
			AND NEW.settled_at IS OLD.settled_at
			AND OLD.reversed_at IS NULL AND OLD.reversal_code IS NULL
			AND NEW.reversed_at IS NOT NULL)
	)
), 0)
BEGIN SELECT RAISE(ABORT, 'restaurant_order_refunds is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `qr_tab_refunds_valid_insert` BEFORE INSERT ON `qr_tab_refunds`
WHEN NOT coalesce((
	NEW.status = 'pending'
	AND NEW.origin IN ('operator', 'station', 'guest', 'system')
	AND NEW.processor IN ('connect', 'checkout')
	AND NEW.failure_code IS NULL
	AND NEW.settled_at IS NULL
	AND NEW.reversed_at IS NULL AND NEW.reversal_code IS NULL
), 0)
BEGIN SELECT RAISE(ABORT, 'qr_tab_refunds: invalid new refund'); END;
--> statement-breakpoint
CREATE TRIGGER `qr_tab_refunds_no_delete` BEFORE DELETE ON `qr_tab_refunds`
BEGIN SELECT RAISE(ABORT, 'qr_tab_refunds is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `qr_tab_refunds_no_update` BEFORE UPDATE ON `qr_tab_refunds`
WHEN NOT coalesce((
	NEW.id IS OLD.id
	AND NEW.tab_id IS OLD.tab_id
	AND NEW.tab_payment_id IS OLD.tab_payment_id
	AND NEW.amount_cents IS OLD.amount_cents
	AND NEW.currency IS OLD.currency
	AND NEW.full IS OLD.full
	AND NEW.actor_id IS OLD.actor_id
	AND NEW.origin IS OLD.origin
	AND NEW.processor IS OLD.processor
	AND NEW.session_id IS OLD.session_id
	AND NEW.idempotency_key IS OLD.idempotency_key
	AND NEW.request_hash IS OLD.request_hash
	AND NEW.created_at IS OLD.created_at
	AND (NEW.note IS OLD.note OR NEW.note IS NULL)
	AND (
		(NEW.status IS OLD.status
			AND NEW.provider_refund_id IS OLD.provider_refund_id
			AND NEW.failure_code IS OLD.failure_code
			AND NEW.settled_at IS OLD.settled_at
			AND NEW.reversed_at IS OLD.reversed_at
			AND NEW.reversal_code IS OLD.reversal_code)
		OR
		(OLD.status = 'pending' AND NEW.status = 'pending'
			AND OLD.provider_refund_id IS NULL AND NEW.provider_refund_id IS NOT NULL
			AND NEW.failure_code IS OLD.failure_code
			AND NEW.settled_at IS NULL
			AND NEW.reversed_at IS NULL AND NEW.reversal_code IS NULL)
		OR
		(OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed')
			AND (OLD.provider_refund_id IS NULL OR NEW.provider_refund_id IS OLD.provider_refund_id)
			AND (NEW.status = 'failed' OR NEW.failure_code IS NULL)
			AND NEW.settled_at IS NOT NULL
			AND NEW.reversed_at IS NULL AND NEW.reversal_code IS NULL)
		OR
		(OLD.status = 'failed' AND NEW.status = 'succeeded'
			AND NEW.provider_refund_id IS NOT NULL
			AND (OLD.provider_refund_id IS NULL OR NEW.provider_refund_id IS OLD.provider_refund_id)
			AND NEW.failure_code IS NULL
			AND NEW.settled_at IS NOT NULL
			AND OLD.reversed_at IS NULL AND OLD.reversal_code IS NULL
			AND NEW.reversed_at IS NULL AND NEW.reversal_code IS NULL)
		OR
		(OLD.status = 'succeeded' AND NEW.status = 'succeeded'
			AND NEW.provider_refund_id IS OLD.provider_refund_id
			AND NEW.failure_code IS OLD.failure_code
			AND NEW.settled_at IS OLD.settled_at
			AND OLD.reversed_at IS NULL AND OLD.reversal_code IS NULL
			AND NEW.reversed_at IS NOT NULL)
	)
), 0)
BEGIN SELECT RAISE(ABORT, 'qr_tab_refunds is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `restaurant_orders_cancel_fields_valid` BEFORE UPDATE OF `cancel_reason`, `cancelled_by`, `rejected_reason`, `dispute_status` ON `restaurant_orders`
WHEN (NEW.cancel_reason IS NOT NULL AND NEW.cancel_reason NOT IN ('out_of_stock', 'kitchen_closed', 'guest_asked', 'duplicate', 'too_busy', 'other', 'not_accepted_in_time'))
	OR (NEW.rejected_reason IS NOT NULL AND NEW.rejected_reason NOT IN ('out_of_stock', 'kitchen_closed', 'guest_asked', 'duplicate', 'too_busy', 'other', 'not_accepted_in_time'))
	OR (NEW.cancelled_by IS NOT NULL AND NEW.cancelled_by NOT IN ('operator', 'guest', 'system'))
	OR (NEW.dispute_status IS NOT NULL AND NEW.dispute_status NOT IN ('open', 'won', 'lost'))
BEGIN SELECT RAISE(ABORT, 'restaurant_orders: invalid cancel or dispute value'); END;

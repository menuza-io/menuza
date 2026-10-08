CREATE TABLE `restaurant_order_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`window_id` text,
	`slot_time` text,
	`quantity` integer NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_restaurant_reservations_entity` ON `restaurant_order_reservations` (`kind`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_reservations_slot_entity` ON `restaurant_order_reservations` (`entity_id`,`window_id`,`slot_time`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_reservations_order` ON `restaurant_order_reservations` (`order_id`);--> statement-breakpoint
CREATE TABLE `restaurant_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text,
	`number` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`status` text DEFAULT 'accepted' NOT NULL,
	`payment_method` text NOT NULL,
	`payment_status` text NOT NULL,
	`payment_processor` text,
	`payment_session_id` text,
	`payment_event_at` integer,
	`fulfillment` text NOT NULL,
	`location_id` text NOT NULL,
	`location_name` text NOT NULL,
	`drop_id` text,
	`drop_slug` text,
	`pickup_window_id` text,
	`pickup_date` text,
	`pickup_time` text,
	`pickup_timezone` text,
	`contact_name` text NOT NULL,
	`contact_phone` text NOT NULL,
	`contact_email` text,
	`delivery_address` text,
	`delivery_city` text,
	`delivery_unit` text,
	`delivery_notes` text,
	`delivery_zone_id` text,
	`currency` text NOT NULL,
	`subtotal_cents` integer NOT NULL,
	`tax_cents` integer NOT NULL,
	`delivery_fee_cents` integer DEFAULT 0 NOT NULL,
	`tip_cents` integer DEFAULT 0 NOT NULL,
	`tip_percent` integer DEFAULT 0 NOT NULL,
	`total_cents` integer NOT NULL,
	`lines` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`receipt_token_hash` text NOT NULL,
	`payment_token_hash` text,
	`hold_expires_at` integer,
	`paid_at` integer,
	`completed_at` integer,
	`cancelled_at` integer,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restaurant_orders_number_unique` ON `restaurant_orders` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `restaurant_orders_idempotency_key_unique` ON `restaurant_orders` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `restaurant_orders_payment_session_id_unique` ON `restaurant_orders` (`payment_session_id`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_status_created` ON `restaurant_orders` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_slot` ON `restaurant_orders` (`pickup_window_id`,`pickup_time`,`status`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_customer` ON `restaurant_orders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_location_created` ON `restaurant_orders` (`location_id`,`created_at`);
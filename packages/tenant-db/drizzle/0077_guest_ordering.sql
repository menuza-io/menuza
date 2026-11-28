CREATE TABLE `customer_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`label` text NOT NULL,
	`formatted` text NOT NULL,
	`line1` text NOT NULL,
	`unit` text,
	`city` text NOT NULL,
	`state` text,
	`postal_code` text,
	`country` text,
	`notes` text,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_customer_addresses_notes" CHECK("customer_addresses"."notes" is null or length("customer_addresses"."notes") <= 280)
);
--> statement-breakpoint
CREATE INDEX `idx_customer_addresses_customer` ON `customer_addresses` (`customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `customer_addresses_one_default` ON `customer_addresses` (`customer_id`) WHERE "customer_addresses"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `customer_favorites` (
	`customer_id` text NOT NULL,
	`item_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`customer_id`, `item_id`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_customer_favorites_customer` ON `customer_favorites` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `group_cart_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`person_id` text NOT NULL,
	`line` text NOT NULL,
	`item_name` text NOT NULL,
	`amount_minor` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `group_carts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `group_cart_people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_group_cart_lines_group` ON `group_cart_lines` (`group_id`);--> statement-breakpoint
CREATE INDEX `idx_group_cart_lines_person` ON `group_cart_lines` (`person_id`);--> statement-breakpoint
CREATE TABLE `group_cart_people` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`first_name` text NOT NULL,
	`is_host` integer DEFAULT false NOT NULL,
	`done_at` integer,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `group_carts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_group_cart_people_group` ON `group_cart_people` (`group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `group_cart_people_token_unique` ON `group_cart_people` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `group_cart_people_one_host` ON `group_cart_people` (`group_id`) WHERE "group_cart_people"."is_host" = 1;--> statement-breakpoint
CREATE TABLE `group_carts` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`host_customer_id` text NOT NULL,
	`host_first_name` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`deadline_at` integer,
	`per_person_limit_minor` integer,
	`total_limit_minor` integer,
	`share_token_version` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`order_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`host_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_group_carts_status" CHECK("group_carts"."status" in ('open', 'locked', 'ordered', 'ended'))
);
--> statement-breakpoint
CREATE INDEX `idx_group_carts_host` ON `group_carts` (`host_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_group_carts_updated` ON `group_carts` (`updated_at`);--> statement-breakpoint
CREATE TABLE `order_problem_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`problem_id` text NOT NULL,
	`kind` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text,
	`body` text,
	`idempotency_key` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`problem_id`) REFERENCES `order_problems`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_order_problem_replies_kind" CHECK("order_problem_replies"."kind" in ('report', 'addition', 'reply', 'refund', 'credit', 'close'))
);
--> statement-breakpoint
CREATE INDEX `idx_order_problem_replies_problem` ON `order_problem_replies` (`problem_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `order_problem_replies_idempotency` ON `order_problem_replies` (`idempotency_key`) WHERE "order_problem_replies"."idempotency_key" is not null;--> statement-breakpoint
CREATE TABLE `order_problems` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`location_id` text NOT NULL,
	`kind` text NOT NULL,
	`item_refs` text DEFAULT '[]' NOT NULL,
	`note` text,
	`photo_key` text,
	`photo_content_type` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution` text,
	`resolved_by` text,
	`resolved_at` integer,
	`refund_id` text,
	`refund_cents` integer,
	`credit_code_id` text,
	`credit_cents` integer,
	`credit_expires_at` integer,
	`notified_at` integer,
	`unanswered_notified_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_order_problems_kind" CHECK("order_problems"."kind" in ('missing_item', 'wrong_item', 'late', 'quality', 'other')),
	CONSTRAINT "chk_order_problems_status" CHECK("order_problems"."status" in ('open', 'answered', 'closed')),
	CONSTRAINT "chk_order_problems_resolution" CHECK("order_problems"."resolution" is null or "order_problems"."resolution" in ('refund', 'credit', 'reply', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_problems_one_open` ON `order_problems` (`order_id`) WHERE "order_problems"."status" = 'open';--> statement-breakpoint
CREATE INDEX `idx_order_problems_order` ON `order_problems` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_order_problems_status` ON `order_problems` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_order_problems_location` ON `order_problems` (`location_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `test_order_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`minted_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`used_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_test_order_nonces_location` ON `test_order_nonces` (`location_id`,`minted_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_discount_issued_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`discount_id` text NOT NULL,
	`code` text NOT NULL,
	`normalized_code` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`customer_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_discount_issued_codes_source_type" CHECK("__new_discount_issued_codes"."source_type" in ('campaign', 'journey', 'loyalty_referral', 'order_problem'))
);
--> statement-breakpoint
INSERT INTO `__new_discount_issued_codes`("id", "discount_id", "code", "normalized_code", "source_type", "source_id", "customer_id", "expires_at", "created_at") SELECT "id", "discount_id", "code", "normalized_code", "source_type", "source_id", "customer_id", "expires_at", "created_at" FROM `discount_issued_codes`;--> statement-breakpoint
DROP TABLE `discount_issued_codes`;--> statement-breakpoint
ALTER TABLE `__new_discount_issued_codes` RENAME TO `discount_issued_codes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `discount_issued_codes_normalized` ON `discount_issued_codes` (`normalized_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `discount_issued_codes_one_per_recipient` ON `discount_issued_codes` (`source_type`,`source_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_discount_issued_codes_discount` ON `discount_issued_codes` (`discount_id`);--> statement-breakpoint
CREATE INDEX `idx_discount_issued_codes_customer` ON `discount_issued_codes` (`customer_id`);--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `is_test` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `test_print_answer` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `test_print_answered_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `group_id` text;--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_test_open` ON `restaurant_orders` (`created_at`) WHERE "restaurant_orders"."is_test" = 1;--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_group` ON `restaurant_orders` (`group_id`) WHERE "restaurant_orders"."group_id" is not null;
--> statement-breakpoint
-- A test order cannot be turned into a real one, nor a real one into a test (#119).
CREATE TRIGGER `restaurant_orders_is_test_final` BEFORE UPDATE OF `is_test` ON `restaurant_orders`
WHEN NEW.is_test IS NOT OLD.is_test
BEGIN SELECT RAISE(ABORT, 'restaurant_orders.is_test is final'); END;
--> statement-breakpoint
-- The thread of an order problem is append-only (#191). Person erasure may only
-- empty a body: nothing else about an entry changes, and nothing is deleted
-- except together with its report (cascade) or by the erasure.
CREATE TRIGGER `order_problem_replies_no_update` BEFORE UPDATE ON `order_problem_replies`
WHEN NOT (
	NEW.body IS NULL
	AND NEW.id IS OLD.id
	AND NEW.problem_id IS OLD.problem_id
	AND NEW.kind IS OLD.kind
	AND NEW.author_kind IS OLD.author_kind
	AND NEW.author_id IS OLD.author_id
	AND NEW.idempotency_key IS OLD.idempotency_key
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'order_problem_replies are append-only'); END;

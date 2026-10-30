CREATE TABLE `loyalty_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`device_id` text NOT NULL,
	`location_id` text,
	`sale_id` text NOT NULL,
	`reward_id` text NOT NULL,
	`reward_version` integer NOT NULL,
	`reward_name` text NOT NULL,
	`points_cost` integer NOT NULL,
	`currency` text NOT NULL,
	`discount_minor` integer NOT NULL,
	`allocation` text NOT NULL,
	`cart` text NOT NULL,
	`cart_hash` text NOT NULL,
	`target_line_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`method` text,
	`otp_hash` text,
	`otp_sent_at` integer,
	`otp_attempts` integer DEFAULT 0 NOT NULL,
	`redemption_id` text,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_loyalty_approvals_points" CHECK("loyalty_approvals"."points_cost" >= 1),
	CONSTRAINT "chk_loyalty_approvals_discount" CHECK("loyalty_approvals"."discount_minor" >= 0),
	CONSTRAINT "chk_loyalty_approvals_status" CHECK("loyalty_approvals"."status" in ('pending', 'approved', 'declined', 'expired', 'cancelled')),
	CONSTRAINT "chk_loyalty_approvals_method" CHECK("loyalty_approvals"."method" in ('wallet', 'otp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_approvals_one_pending_per_sale` ON `loyalty_approvals` (`sale_id`) WHERE "loyalty_approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `idx_loyalty_approvals_member_status` ON `loyalty_approvals` (`member_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_approvals_expires` ON `loyalty_approvals` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_approvals_sale` ON `loyalty_approvals` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_approvals_status_updated` ON `loyalty_approvals` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `loyalty_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`location_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`changes` text,
	CONSTRAINT "chk_loyalty_audit_log_actor_kind" CHECK("loyalty_audit_log"."actor_kind" in ('system', 'operator', 'customer', 'station'))
);
--> statement-breakpoint
CREATE INDEX `idx_loyalty_audit_log_at` ON `loyalty_audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_audit_log_entity` ON `loyalty_audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `loyalty_balances` (
	`member_id` text PRIMARY KEY NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`reserved` integer DEFAULT 0 NOT NULL,
	`lifetime_earned` integer DEFAULT 0 NOT NULL,
	`lifetime_redeemed` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_loyalty_balances_reserved" CHECK("loyalty_balances"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE `loyalty_idempotency_keys` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`status_code` integer NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	`member_id` text,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idx_loyalty_idempotency_keys_expires` ON `loyalty_idempotency_keys` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_idempotency_keys_member` ON `loyalty_idempotency_keys` (`member_id`);--> statement-breakpoint
CREATE TABLE `loyalty_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`type` text NOT NULL,
	`delta` integer NOT NULL,
	`event_key` text NOT NULL,
	`purchase_id` text,
	`redemption_id` text,
	`channel` text,
	`location_id` text,
	`program_version` integer,
	`reason` text,
	`note` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `loyalty_purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redemption_id`) REFERENCES `loyalty_redemptions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_loyalty_ledger_delta_sign" CHECK(("loyalty_ledger"."type" in ('earn', 'redeem_restore') and "loyalty_ledger"."delta" > 0) or ("loyalty_ledger"."type" in ('earn_reversal', 'redeem') and "loyalty_ledger"."delta" < 0) or ("loyalty_ledger"."type" = 'adjust' and "loyalty_ledger"."delta" <> 0)),
	CONSTRAINT "chk_loyalty_ledger_adjust_reason" CHECK("loyalty_ledger"."type" <> 'adjust' or "loyalty_ledger"."reason" is not null),
	CONSTRAINT "chk_loyalty_ledger_type" CHECK("loyalty_ledger"."type" in ('earn', 'earn_reversal', 'redeem', 'redeem_restore', 'adjust')),
	CONSTRAINT "chk_loyalty_ledger_channel" CHECK("loyalty_ledger"."channel" in ('web', 'pos', 'qr', 'native')),
	CONSTRAINT "chk_loyalty_ledger_reason" CHECK("loyalty_ledger"."reason" in ('goodwill', 'correction', 'service_recovery', 'fraud', 'other')),
	CONSTRAINT "chk_loyalty_ledger_actor_kind" CHECK("loyalty_ledger"."actor_kind" in ('system', 'operator', 'customer', 'station'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_ledger_event_key_unique` ON `loyalty_ledger` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_member_at` ON `loyalty_ledger` (`member_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_at` ON `loyalty_ledger` (`at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_purchase` ON `loyalty_ledger` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_redemption` ON `loyalty_ledger` (`redemption_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_location_at` ON `loyalty_ledger` (`location_id`,`at`);--> statement-breakpoint
CREATE TABLE `loyalty_member_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_member_bindings_hash_unique` ON `loyalty_member_bindings` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_member_bindings_member` ON `loyalty_member_bindings` (`member_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_member_bindings_device` ON `loyalty_member_bindings` (`device_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `loyalty_member_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by_device_id` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_member_codes_hash_unique` ON `loyalty_member_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_member_codes_member` ON `loyalty_member_codes` (`member_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_member_codes_expires` ON `loyalty_member_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `loyalty_members` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`last_purchase_at` integer,
	`suspended_at` integer,
	`erased_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_loyalty_members_status" CHECK("loyalty_members"."status" in ('active', 'suspended', 'erased'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_members_customer_unique` ON `loyalty_members` (`customer_id`) WHERE "loyalty_members"."customer_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_loyalty_members_last_purchase` ON `loyalty_members` (`last_purchase_at`);--> statement-breakpoint
CREATE TABLE `loyalty_outbox` (
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`done_at` integer,
	`claimed_until` integer,
	PRIMARY KEY(`source_type`, `source_id`),
	CONSTRAINT "chk_loyalty_outbox_source_type" CHECK("loyalty_outbox"."source_type" in ('restaurant_order', 'qr_tab', 'pos_order')),
	CONSTRAINT "chk_loyalty_outbox_status" CHECK("loyalty_outbox"."status" in ('pending', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_loyalty_outbox_due` ON `loyalty_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `loyalty_program_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`method` text NOT NULL,
	`currency` text NOT NULL,
	`config` text NOT NULL,
	`effective_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`program_id`) REFERENCES `loyalty_programs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_loyalty_program_versions_status" CHECK("loyalty_program_versions"."status" in ('draft', 'active', 'paused')),
	CONSTRAINT "chk_loyalty_program_versions_method" CHECK("loyalty_program_versions"."method" in ('spend', 'visit', 'items', 'categories'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_program_versions_version` ON `loyalty_program_versions` (`program_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_program_versions_effective` ON `loyalty_program_versions` (`program_id`,`effective_at`);--> statement-breakpoint
CREATE TABLE `loyalty_programs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`current_version` integer NOT NULL,
	`currency` text NOT NULL,
	`activated_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_loyalty_programs_singleton" CHECK("loyalty_programs"."id" = 'default'),
	CONSTRAINT "chk_loyalty_programs_status" CHECK("loyalty_programs"."status" in ('draft', 'active', 'paused'))
);
--> statement-breakpoint
CREATE TABLE `loyalty_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`channel` text NOT NULL,
	`location_id` text,
	`currency` text NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`review_reason` text,
	`excluded_reason` text,
	`skip_reason` text,
	`program_version` integer,
	`occurred_at` integer,
	`visit_date` text,
	`visit_awarded` integer DEFAULT false NOT NULL,
	`snapshot` text,
	`eligible_minor` integer DEFAULT 0 NOT NULL,
	`total_paid_minor` integer DEFAULT 0 NOT NULL,
	`awarded_points` integer DEFAULT 0 NOT NULL,
	`reversed_points` integer DEFAULT 0 NOT NULL,
	`refunded_minor` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_loyalty_purchases_points" CHECK("loyalty_purchases"."awarded_points" >= 0 AND "loyalty_purchases"."reversed_points" >= 0 AND "loyalty_purchases"."reversed_points" <= "loyalty_purchases"."awarded_points"),
	CONSTRAINT "chk_loyalty_purchases_money" CHECK("loyalty_purchases"."eligible_minor" >= 0 AND "loyalty_purchases"."total_paid_minor" >= 0 AND "loyalty_purchases"."refunded_minor" >= 0),
	CONSTRAINT "chk_loyalty_purchases_visit_date" CHECK("loyalty_purchases"."visit_awarded" = 0 or "loyalty_purchases"."visit_date" is not null),
	CONSTRAINT "chk_loyalty_purchases_source_type" CHECK("loyalty_purchases"."source_type" in ('restaurant_order', 'qr_tab', 'pos_order')),
	CONSTRAINT "chk_loyalty_purchases_channel" CHECK("loyalty_purchases"."channel" in ('web', 'pos', 'qr', 'native')),
	CONSTRAINT "chk_loyalty_purchases_state" CHECK("loyalty_purchases"."state" in ('open', 'completed', 'review', 'excluded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_purchases_source_unique` ON `loyalty_purchases` (`source_type`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_purchases_one_visit_per_day` ON `loyalty_purchases` (`member_id`,`visit_date`) WHERE "loyalty_purchases"."visit_awarded" = 1;--> statement-breakpoint
CREATE INDEX `idx_loyalty_purchases_member_occurred` ON `loyalty_purchases` (`member_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_purchases_state_updated` ON `loyalty_purchases` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_purchases_occurred` ON `loyalty_purchases` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_purchases_state_occurred` ON `loyalty_purchases` (`state`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `loyalty_rate_counters` (
	`bucket` text NOT NULL,
	`subject_hash` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`bucket`, `subject_hash`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `idx_loyalty_rate_counters_window` ON `loyalty_rate_counters` (`window_start`);--> statement-breakpoint
CREATE TABLE `loyalty_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`reward_id` text NOT NULL,
	`reward_version` integer NOT NULL,
	`reward_name` text NOT NULL,
	`reward_snapshot` text NOT NULL,
	`points` integer NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`review_reason` text,
	`release_reason` text,
	`channel` text NOT NULL,
	`source_type` text,
	`source_id` text,
	`location_id` text,
	`device_id` text,
	`approval_id` text,
	`currency` text NOT NULL,
	`cart_hash` text NOT NULL,
	`discount_minor` integer NOT NULL,
	`allocation` text NOT NULL,
	`target_line_id` text,
	`expires_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`bound_at` integer,
	`consumed_at` integer,
	`released_at` integer,
	`restored_at` integer,
	`review_at` integer,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reward_id`) REFERENCES `loyalty_rewards`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_loyalty_redemptions_points" CHECK("loyalty_redemptions"."points" >= 1),
	CONSTRAINT "chk_loyalty_redemptions_discount" CHECK("loyalty_redemptions"."discount_minor" >= 0),
	CONSTRAINT "chk_loyalty_redemptions_bound_source" CHECK("loyalty_redemptions"."state" in ('reserved', 'released') or "loyalty_redemptions"."source_id" is not null),
	CONSTRAINT "chk_loyalty_redemptions_state" CHECK("loyalty_redemptions"."state" in ('reserved', 'bound', 'consumed', 'released', 'review', 'restored')),
	CONSTRAINT "chk_loyalty_redemptions_channel" CHECK("loyalty_redemptions"."channel" in ('web', 'pos', 'qr', 'native')),
	CONSTRAINT "chk_loyalty_redemptions_source_type" CHECK("loyalty_redemptions"."source_type" in ('restaurant_order', 'qr_tab', 'pos_order'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_redemptions_one_per_source` ON `loyalty_redemptions` (`source_type`,`source_id`) WHERE "loyalty_redemptions"."source_id" is not null and "loyalty_redemptions"."state" <> 'released';--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_redemptions_approval_unique` ON `loyalty_redemptions` (`approval_id`) WHERE "loyalty_redemptions"."approval_id" is not null;--> statement-breakpoint
CREATE INDEX `idx_loyalty_redemptions_member_state` ON `loyalty_redemptions` (`member_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_redemptions_state_updated` ON `loyalty_redemptions` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_redemptions_state_expires` ON `loyalty_redemptions` (`state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_redemptions_state_consumed` ON `loyalty_redemptions` (`state`,`consumed_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_redemptions_state_restored` ON `loyalty_redemptions` (`state`,`restored_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_redemptions_state_released` ON `loyalty_redemptions` (`state`,`released_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_redemptions_source` ON `loyalty_redemptions` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `loyalty_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`purchase_id` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`full` integer DEFAULT false NOT NULL,
	`note` text,
	`actor_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `loyalty_purchases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_loyalty_refunds_amount" CHECK("loyalty_refunds"."amount_minor" >= 0),
	CONSTRAINT "chk_loyalty_refunds_source_type" CHECK("loyalty_refunds"."source_type" in ('restaurant_order', 'qr_tab'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_refunds_idempotency_unique` ON `loyalty_refunds` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_refunds_source` ON `loyalty_refunds` (`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_refunds_created` ON `loyalty_refunds` (`created_at`);--> statement-breakpoint
CREATE TABLE `loyalty_reward_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`reward_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`currency` text NOT NULL,
	`definition` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`reward_id`) REFERENCES `loyalty_rewards`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_loyalty_reward_versions_status" CHECK("loyalty_reward_versions"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_reward_versions_version` ON `loyalty_reward_versions` (`reward_id`,`version`);--> statement-breakpoint
CREATE TABLE `loyalty_rewards` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`points_cost` integer NOT NULL,
	`currency` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	CONSTRAINT "chk_loyalty_rewards_cost" CHECK("loyalty_rewards"."points_cost" >= 1),
	CONSTRAINT "chk_loyalty_rewards_status" CHECK("loyalty_rewards"."status" in ('active', 'archived')),
	CONSTRAINT "chk_loyalty_rewards_kind" CHECK("loyalty_rewards"."kind" in ('order', 'categories', 'items', 'free_item'))
);
--> statement-breakpoint
CREATE INDEX `idx_loyalty_rewards_status_cost` ON `loyalty_rewards` (`status`,`points_cost`);--> statement-breakpoint
CREATE TABLE `restaurant_order_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`full` integer DEFAULT false NOT NULL,
	`note` text,
	`actor_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_restaurant_order_refunds_amount" CHECK("restaurant_order_refunds"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restaurant_order_refunds_idempotency_unique` ON `restaurant_order_refunds` (`order_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_order_refunds_order` ON `restaurant_order_refunds` (`order_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_order_refunds_created` ON `restaurant_order_refunds` (`created_at`);--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `loyalty_discount_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `rung_up_on_station` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `loyalty_discount_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `refunded_cents` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `loyalty_programs_no_delete` BEFORE DELETE ON `loyalty_programs`
BEGIN SELECT RAISE(ABORT, 'loyalty_programs rows are kept'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_programs_currency_locked` BEFORE UPDATE ON `loyalty_programs`
WHEN OLD.activated_at IS NOT NULL AND NEW.currency IS NOT OLD.currency
BEGIN SELECT RAISE(ABORT, 'loyalty program currency is locked'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_program_versions_no_update` BEFORE UPDATE ON `loyalty_program_versions`
BEGIN SELECT RAISE(ABORT, 'loyalty_program_versions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_program_versions_no_delete` BEFORE DELETE ON `loyalty_program_versions`
BEGIN SELECT RAISE(ABORT, 'loyalty_program_versions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_rewards_no_delete` BEFORE DELETE ON `loyalty_rewards`
BEGIN SELECT RAISE(ABORT, 'loyalty_rewards rows are archived, not deleted'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_reward_versions_no_update` BEFORE UPDATE ON `loyalty_reward_versions`
BEGIN SELECT RAISE(ABORT, 'loyalty_reward_versions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_reward_versions_no_delete` BEFORE DELETE ON `loyalty_reward_versions`
BEGIN SELECT RAISE(ABORT, 'loyalty_reward_versions is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_members_no_delete` BEFORE DELETE ON `loyalty_members`
BEGIN SELECT RAISE(ABORT, 'loyalty_members rows are erased, not deleted'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_members_erased_final` BEFORE UPDATE ON `loyalty_members`
WHEN OLD.status = 'erased' AND (NEW.status IS NOT 'erased' OR NEW.customer_id IS NOT NULL OR NEW.erased_at IS NOT OLD.erased_at)
BEGIN SELECT RAISE(ABORT, 'loyalty member is erased'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_members_customer_fixed` BEFORE UPDATE OF `customer_id` ON `loyalty_members`
WHEN NEW.customer_id IS NOT NULL AND NEW.customer_id IS NOT OLD.customer_id
BEGIN SELECT RAISE(ABORT, 'loyalty member customer link is fixed'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_balances_no_delete` BEFORE DELETE ON `loyalty_balances`
BEGIN SELECT RAISE(ABORT, 'loyalty_balances rows are kept'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_purchases_no_delete` BEFORE DELETE ON `loyalty_purchases`
BEGIN SELECT RAISE(ABORT, 'loyalty_purchases rows are kept'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_purchases_identity_fixed` BEFORE UPDATE ON `loyalty_purchases`
WHEN NEW.id IS NOT OLD.id
	OR NEW.member_id IS NOT OLD.member_id
	OR NEW.source_type IS NOT OLD.source_type
	OR NEW.source_id IS NOT OLD.source_id
BEGIN SELECT RAISE(ABORT, 'loyalty_purchases identity is fixed'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_redemptions_no_delete` BEFORE DELETE ON `loyalty_redemptions`
BEGIN SELECT RAISE(ABORT, 'loyalty_redemptions rows are kept'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_redemptions_born_open` BEFORE INSERT ON `loyalty_redemptions`
WHEN NEW.state NOT IN ('reserved', 'bound')
BEGIN SELECT RAISE(ABORT, 'loyalty_redemptions start reserved or bound'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_redemptions_transition` BEFORE UPDATE OF `state` ON `loyalty_redemptions`
WHEN NEW.state IS NOT OLD.state AND NOT (
	(OLD.state = 'reserved' AND NEW.state IN ('bound', 'released'))
	OR (OLD.state = 'bound' AND NEW.state IN ('consumed', 'released', 'review'))
	OR (OLD.state = 'review' AND NEW.state IN ('consumed', 'released'))
	OR (OLD.state = 'consumed' AND NEW.state = 'restored')
)
BEGIN SELECT RAISE(ABORT, 'loyalty_redemptions transition not allowed'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_redemptions_fixed` BEFORE UPDATE ON `loyalty_redemptions`
WHEN NEW.id IS NOT OLD.id
	OR NEW.member_id IS NOT OLD.member_id
	OR NEW.reward_id IS NOT OLD.reward_id
	OR NEW.reward_version IS NOT OLD.reward_version
	OR NEW.reward_name IS NOT OLD.reward_name
	OR NEW.reward_snapshot IS NOT OLD.reward_snapshot
	OR NEW.points IS NOT OLD.points
	OR NEW.currency IS NOT OLD.currency
	OR NEW.channel IS NOT OLD.channel
	OR NEW.created_at IS NOT OLD.created_at
	OR (OLD.state <> 'reserved' AND (
		NEW.source_type IS NOT OLD.source_type
		OR NEW.source_id IS NOT OLD.source_id
		OR NEW.cart_hash IS NOT OLD.cart_hash
		OR NEW.discount_minor IS NOT OLD.discount_minor
		OR NEW.allocation IS NOT OLD.allocation
		OR NEW.target_line_id IS NOT OLD.target_line_id
	))
	OR (OLD.state IN ('consumed', 'released', 'restored') AND (
		NEW.approval_id IS NOT OLD.approval_id
		OR NEW.device_id IS NOT OLD.device_id
		OR NEW.location_id IS NOT OLD.location_id
		OR NEW.expires_at IS NOT OLD.expires_at
	))
BEGIN SELECT RAISE(ABORT, 'loyalty_redemptions facts are fixed'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_ledger_no_delete` BEFORE DELETE ON `loyalty_ledger`
BEGIN SELECT RAISE(ABORT, 'loyalty_ledger is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_ledger_no_update` BEFORE UPDATE ON `loyalty_ledger`
WHEN NOT (
	NEW.note IS NULL
	AND NEW.id IS OLD.id
	AND NEW.member_id IS OLD.member_id
	AND NEW.type IS OLD.type
	AND NEW.delta IS OLD.delta
	AND NEW.event_key IS OLD.event_key
	AND NEW.purchase_id IS OLD.purchase_id
	AND NEW.redemption_id IS OLD.redemption_id
	AND NEW.channel IS OLD.channel
	AND NEW.location_id IS OLD.location_id
	AND NEW.program_version IS OLD.program_version
	AND NEW.reason IS OLD.reason
	AND NEW.actor_kind IS OLD.actor_kind
	AND NEW.actor_id IS OLD.actor_id
	AND NEW.at IS OLD.at
)
BEGIN SELECT RAISE(ABORT, 'loyalty_ledger is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_refunds_no_delete` BEFORE DELETE ON `loyalty_refunds`
BEGIN SELECT RAISE(ABORT, 'loyalty_refunds is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_refunds_no_update` BEFORE UPDATE ON `loyalty_refunds`
WHEN NOT (
	NEW.note IS NULL
	AND NEW.id IS OLD.id
	AND NEW.source_type IS OLD.source_type
	AND NEW.source_id IS OLD.source_id
	AND NEW.purchase_id IS OLD.purchase_id
	AND NEW.amount_minor IS OLD.amount_minor
	AND NEW.currency IS OLD.currency
	AND NEW.full IS OLD.full
	AND NEW.actor_id IS OLD.actor_id
	AND NEW.idempotency_key IS OLD.idempotency_key
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'loyalty_refunds is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_member_codes_single_use` BEFORE UPDATE ON `loyalty_member_codes`
WHEN OLD.used_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'loyalty member code already used'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_audit_log_no_delete` BEFORE DELETE ON `loyalty_audit_log`
BEGIN SELECT RAISE(ABORT, 'loyalty_audit_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_audit_log_no_update` BEFORE UPDATE ON `loyalty_audit_log`
WHEN NOT (
	NEW.changes IS '{"redacted":true}'
	AND NEW.id IS OLD.id
	AND NEW.at IS OLD.at
	AND NEW.actor_kind IS OLD.actor_kind
	AND NEW.actor_id IS OLD.actor_id
	AND NEW.location_id IS OLD.location_id
	AND NEW.action IS OLD.action
	AND NEW.entity_type IS OLD.entity_type
	AND NEW.entity_id IS OLD.entity_id
)
BEGIN SELECT RAISE(ABORT, 'loyalty_audit_log is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `restaurant_order_refunds_no_delete` BEFORE DELETE ON `restaurant_order_refunds`
BEGIN SELECT RAISE(ABORT, 'restaurant_order_refunds is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `restaurant_order_refunds_no_update` BEFORE UPDATE ON `restaurant_order_refunds`
WHEN NOT (
	NEW.note IS NULL
	AND NEW.id IS OLD.id
	AND NEW.order_id IS OLD.order_id
	AND NEW.amount_cents IS OLD.amount_cents
	AND NEW.currency IS OLD.currency
	AND NEW.full IS OLD.full
	AND NEW.actor_id IS OLD.actor_id
	AND NEW.idempotency_key IS OLD.idempotency_key
	AND NEW.request_hash IS OLD.request_hash
	AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'restaurant_order_refunds is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `restaurant_orders_refunded_cents_guard` BEFORE UPDATE OF `refunded_cents` ON `restaurant_orders`
WHEN NEW.refunded_cents < OLD.refunded_cents OR NEW.refunded_cents > NEW.total_cents
BEGIN SELECT RAISE(ABORT, 'restaurant_orders refunds only add up to the total'); END;

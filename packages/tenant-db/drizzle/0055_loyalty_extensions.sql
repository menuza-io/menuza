CREATE TABLE `loyalty_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`channel` text NOT NULL,
	`payload` text,
	`sent_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_loyalty_notices_kind" CHECK("loyalty_notices"."kind" in ('tier_downgrade_warning', 'expiry_30d', 'expiry_7d', 'expiry_enabled')),
	CONSTRAINT "chk_loyalty_notices_channel" CHECK("loyalty_notices"."channel" in ('email', 'sms', 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_notices_member_kind_dedupe` ON `loyalty_notices` (`member_id`,`kind`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_notices_member` ON `loyalty_notices` (`member_id`);--> statement-breakpoint
CREATE TABLE `loyalty_referral_codes` (
	`member_id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_referral_codes_code_unique` ON `loyalty_referral_codes` (`code`);--> statement-breakpoint
CREATE TABLE `loyalty_referrals` (
	`id` text PRIMARY KEY NOT NULL,
	`referrer_member_id` text,
	`referral_code` text NOT NULL,
	`friend_customer_id` text,
	`friend_member_id` text,
	`friend_phone_hash` text NOT NULL,
	`device_hash` text,
	`issued_discount_code_id` text,
	`order_id` text,
	`status` text DEFAULT 'claimed' NOT NULL,
	`referrer_points` integer DEFAULT 0 NOT NULL,
	`friend_points` integer DEFAULT 0 NOT NULL,
	`friend_discount_minor` integer DEFAULT 0 NOT NULL,
	`hold_until` integer,
	`credited_at` integer,
	`reversed_at` integer,
	`cancelled_reason` text,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`updated_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`referrer_member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`friend_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`friend_member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "chk_loyalty_referrals_status" CHECK("loyalty_referrals"."status" in ('claimed', 'pending_order', 'holding', 'credited', 'cancelled', 'reversed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_referrals_order_unique` ON `loyalty_referrals` (`order_id`) WHERE "loyalty_referrals"."order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_referrals_friend_phone_active` ON `loyalty_referrals` (`friend_phone_hash`) WHERE "loyalty_referrals"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX `idx_loyalty_referrals_referrer_status` ON `loyalty_referrals` (`referrer_member_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_referrals_friend_phone` ON `loyalty_referrals` (`friend_phone_hash`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_referrals_friend_customer` ON `loyalty_referrals` (`friend_customer_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_referrals_device` ON `loyalty_referrals` (`device_hash`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_referrals_status_hold` ON `loyalty_referrals` (`status`,`hold_until`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_referrals_discount_code` ON `loyalty_referrals` (`issued_discount_code_id`);--> statement-breakpoint
CREATE TABLE `loyalty_welcome_grants` (
	`phone_hash` text PRIMARY KEY NOT NULL,
	`member_id` text,
	`purchase_id` text,
	`points` integer NOT NULL,
	`trigger` text NOT NULL,
	`granted_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`reversed_at` integer,
	`reversed_purchase_id` text,
	CONSTRAINT "chk_loyalty_welcome_grants_points" CHECK("loyalty_welcome_grants"."points" >= 1),
	CONSTRAINT "chk_loyalty_welcome_grants_trigger" CHECK("loyalty_welcome_grants"."trigger" in ('join', 'first_order'))
);
--> statement-breakpoint
CREATE INDEX `idx_loyalty_welcome_grants_member` ON `loyalty_welcome_grants` (`member_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_welcome_grants_purchase` ON `loyalty_welcome_grants` (`purchase_id`);--> statement-breakpoint
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
	CONSTRAINT "chk_discount_issued_codes_source_type" CHECK("__new_discount_issued_codes"."source_type" in ('campaign', 'journey', 'loyalty_referral'))
);
--> statement-breakpoint
INSERT INTO `__new_discount_issued_codes`("id", "discount_id", "code", "normalized_code", "source_type", "source_id", "customer_id", "expires_at", "created_at") SELECT "id", "discount_id", "code", "normalized_code", "source_type", "source_id", "customer_id", "expires_at", "created_at" FROM `discount_issued_codes`;--> statement-breakpoint
DROP TABLE `discount_issued_codes`;--> statement-breakpoint
ALTER TABLE `__new_discount_issued_codes` RENAME TO `discount_issued_codes`;--> statement-breakpoint
CREATE UNIQUE INDEX `discount_issued_codes_normalized` ON `discount_issued_codes` (`normalized_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `discount_issued_codes_one_per_recipient` ON `discount_issued_codes` (`source_type`,`source_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_discount_issued_codes_discount` ON `discount_issued_codes` (`discount_id`);--> statement-breakpoint
CREATE INDEX `idx_discount_issued_codes_customer` ON `discount_issued_codes` (`customer_id`);--> statement-breakpoint
CREATE TRIGGER `discount_issued_codes_fixed` BEFORE UPDATE ON `discount_issued_codes`
WHEN NEW.id IS NOT OLD.id
	OR NEW.discount_id IS NOT OLD.discount_id
	OR NEW.code IS NOT OLD.code
	OR NEW.normalized_code IS NOT OLD.normalized_code
	OR NEW.source_type IS NOT OLD.source_type
	OR NEW.source_id IS NOT OLD.source_id
	OR NEW.expires_at IS NOT OLD.expires_at
	OR NEW.created_at IS NOT OLD.created_at
	OR (NEW.customer_id IS NOT OLD.customer_id AND NEW.customer_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'discount_issued_codes rows only lose their customer'); END;--> statement-breakpoint
CREATE TABLE `__new_loyalty_ledger` (
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
	CONSTRAINT "chk_loyalty_ledger_delta_sign" CHECK(("__new_loyalty_ledger"."type" in ('earn', 'redeem_restore', 'welcome', 'referral') and "__new_loyalty_ledger"."delta" > 0) or ("__new_loyalty_ledger"."type" in ('earn_reversal', 'redeem', 'welcome_reversal', 'expired', 'referral_reversal') and "__new_loyalty_ledger"."delta" < 0) or ("__new_loyalty_ledger"."type" = 'adjust' and "__new_loyalty_ledger"."delta" <> 0)),
	CONSTRAINT "chk_loyalty_ledger_adjust_reason" CHECK("__new_loyalty_ledger"."type" <> 'adjust' or "__new_loyalty_ledger"."reason" is not null),
	CONSTRAINT "chk_loyalty_ledger_type" CHECK("__new_loyalty_ledger"."type" in ('earn', 'earn_reversal', 'redeem', 'redeem_restore', 'adjust', 'welcome', 'welcome_reversal', 'expired', 'referral', 'referral_reversal')),
	CONSTRAINT "chk_loyalty_ledger_channel" CHECK("__new_loyalty_ledger"."channel" in ('web', 'pos', 'qr', 'native')),
	CONSTRAINT "chk_loyalty_ledger_reason" CHECK("__new_loyalty_ledger"."reason" in ('goodwill', 'correction', 'service_recovery', 'fraud', 'other')),
	CONSTRAINT "chk_loyalty_ledger_actor_kind" CHECK("__new_loyalty_ledger"."actor_kind" in ('system', 'operator', 'customer', 'station'))
);
--> statement-breakpoint
INSERT INTO `__new_loyalty_ledger`("id", "member_id", "type", "delta", "event_key", "purchase_id", "redemption_id", "channel", "location_id", "program_version", "reason", "note", "actor_kind", "actor_id", "at") SELECT "id", "member_id", "type", "delta", "event_key", "purchase_id", "redemption_id", "channel", "location_id", "program_version", "reason", "note", "actor_kind", "actor_id", "at" FROM `loyalty_ledger`;--> statement-breakpoint
DROP TABLE `loyalty_ledger`;--> statement-breakpoint
ALTER TABLE `__new_loyalty_ledger` RENAME TO `loyalty_ledger`;--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_ledger_event_key_unique` ON `loyalty_ledger` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_member_at` ON `loyalty_ledger` (`member_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_at` ON `loyalty_ledger` (`at`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_purchase` ON `loyalty_ledger` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_redemption` ON `loyalty_ledger` (`redemption_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_ledger_location_at` ON `loyalty_ledger` (`location_id`,`at`);--> statement-breakpoint
CREATE TRIGGER `loyalty_ledger_no_delete` BEFORE DELETE ON `loyalty_ledger`
BEGIN SELECT RAISE(ABORT, 'loyalty_ledger is append-only'); END;--> statement-breakpoint
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
BEGIN SELECT RAISE(ABORT, 'loyalty_ledger is append-only'); END;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `loyalty_members` ADD `imported` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `loyalty_members` ADD `tier_id` text;--> statement-breakpoint
ALTER TABLE `loyalty_members` ADD `tier_review_at` integer;--> statement-breakpoint
ALTER TABLE `loyalty_members` ADD `tier_grace_until` integer;--> statement-breakpoint
ALTER TABLE `loyalty_members` ADD `tier_updated_at` integer;--> statement-breakpoint
CREATE INDEX `idx_loyalty_members_tier` ON `loyalty_members` (`tier_id`);--> statement-breakpoint
CREATE INDEX `idx_loyalty_members_tier_review` ON `loyalty_members` (`tier_review_at`);--> statement-breakpoint
ALTER TABLE `loyalty_purchases` ADD `tier_id` text;--> statement-breakpoint
ALTER TABLE `loyalty_purchases` ADD `tier_multiplier_bp` integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE `loyalty_purchases` ADD `qualifying_points` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `loyalty_purchases` SET `qualifying_points` = MAX(0, `awarded_points` - `reversed_points`);
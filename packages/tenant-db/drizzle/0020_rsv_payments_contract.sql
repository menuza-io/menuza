ALTER TABLE `rsv_payments` ADD `purpose` text;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `provider_session_id` text;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `refunded_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `platform_fee_bp` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `attempt` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `decline_code` text;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `previous_payment_ref` text;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `card_exp_month` integer;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `card_exp_year` integer;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `dispute_status` text;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `dispute_ref` text;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `parent_payment_id` text;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `refund_ref` text;--> statement-breakpoint
ALTER TABLE `rsv_payments` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_rsv_payments_provider_session` ON `rsv_payments` (`provider_session_id`) WHERE "rsv_payments"."provider_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_rsv_payments_parent` ON `rsv_payments` (`parent_payment_id`);
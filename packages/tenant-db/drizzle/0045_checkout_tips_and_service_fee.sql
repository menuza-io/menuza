-- Checkout tips and the guest service fee (#118, #123).
--
-- `restaurant_orders.tip_percent` becomes nullable: null means the guest typed
-- an exact amount (`tip_cents` is the tip). SQLite cannot drop NOT NULL in
-- place, and rebuilding `restaurant_orders` would also rebuild its foreign keys,
-- indexes and triggers, so the column is swapped: the old values are parked in
-- a temporary column, the NOT NULL column is dropped, a nullable one of the same
-- name is added, and the values are copied back. No index, trigger or view
-- reads `tip_percent`, so DROP COLUMN is allowed. Existing orders keep their
-- percent.
ALTER TABLE `restaurant_orders` ADD `tip_percent_tmp` integer;--> statement-breakpoint
UPDATE `restaurant_orders` SET `tip_percent_tmp` = `tip_percent`;--> statement-breakpoint
ALTER TABLE `restaurant_orders` DROP COLUMN `tip_percent`;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `tip_percent` integer;--> statement-breakpoint
UPDATE `restaurant_orders` SET `tip_percent` = `tip_percent_tmp`;--> statement-breakpoint
ALTER TABLE `restaurant_orders` DROP COLUMN `tip_percent_tmp`;--> statement-breakpoint
-- The service fee on an online order: before its tax; the tax is part of
-- `tax_cents`. Zero for every order placed before this migration.
ALTER TABLE `restaurant_orders` ADD `service_fee_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `service_fee_tax_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `service_fee_label` text;--> statement-breakpoint
-- A QR tab paid from the phone: the fee the bound session charges, and the
-- snapshot taken when the tab closes.
ALTER TABLE `qr_tabs` ADD `service_fee_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `service_fee_tax_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `service_fee_label` text;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `payment_service_fee_cents` integer;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `payment_service_fee_tax_cents` integer;--> statement-breakpoint
ALTER TABLE `qr_tabs` ADD `payment_service_fee_label` text;--> statement-breakpoint
-- The part of a refund that is the service fee and its tax.
ALTER TABLE `restaurant_order_refunds` ADD `service_fee_cents` integer DEFAULT 0 NOT NULL;

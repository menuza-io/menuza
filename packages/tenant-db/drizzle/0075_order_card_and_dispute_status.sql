ALTER TABLE `restaurant_orders` ADD `card_brand` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `card_last4` text;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `disputed_lost_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `dispute_fee_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_card_last4` ON `restaurant_orders` (`card_last4`) WHERE "restaurant_orders"."card_last4" is not null;
ALTER TABLE `pos_orders` ADD `ready_text_phone` text;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `ready_text_sent_at` integer;--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `ready_text_status` text;--> statement-breakpoint
CREATE INDEX `idx_pos_orders_ready_text_sent` ON `pos_orders` (`ready_text_sent_at`) WHERE "pos_orders"."ready_text_status" = 'sent';
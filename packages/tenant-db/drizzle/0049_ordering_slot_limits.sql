-- Ready-time slot for capacity (#108): ASAP orders store kitchen-ready instant here.
ALTER TABLE `restaurant_orders` ADD `ready_slot_at` integer;--> statement-breakpoint
ALTER TABLE `restaurant_orders` ADD `ready_slot_units` integer;--> statement-breakpoint
CREATE INDEX `idx_restaurant_orders_location_ready_slot` ON `restaurant_orders` (`location_id`, `ready_slot_at`, `status`);
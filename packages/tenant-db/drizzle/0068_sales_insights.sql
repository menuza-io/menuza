CREATE TABLE `restaurant_order_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`step` text NOT NULL,
	`event` text DEFAULT 'done' NOT NULL,
	`at` integer NOT NULL,
	`recorded_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`source` text NOT NULL,
	`offline` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `restaurant_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_restaurant_order_steps_step" CHECK("restaurant_order_steps"."step" in ('placed', 'accepted', 'declined', 'started', 'ready', 'handed_over', 'out_for_delivery', 'delivered')),
	CONSTRAINT "chk_restaurant_order_steps_event" CHECK("restaurant_order_steps"."event" in ('done', 'undone'))
);
--> statement-breakpoint
CREATE INDEX `idx_restaurant_order_steps_order` ON `restaurant_order_steps` (`order_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `idx_restaurant_order_steps_step_at` ON `restaurant_order_steps` (`step`,`at`);--> statement-breakpoint
ALTER TABLE `pos_orders` ADD `line_catalog` text;
--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers; regenerating loses them).
-- Order steps (#243) are append-only: a step taken back is a new row, never an
-- edit. A row can only go with its order (the cascade of the order's own
-- deletion, when the order is already gone), never on its own.
CREATE TRIGGER `restaurant_order_steps_no_update` BEFORE UPDATE ON `restaurant_order_steps`
BEGIN SELECT RAISE(ABORT, 'restaurant_order_steps is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `restaurant_order_steps_no_delete` BEFORE DELETE ON `restaurant_order_steps`
WHEN EXISTS (SELECT 1 FROM `restaurant_orders` WHERE `id` = OLD.`order_id`)
BEGIN SELECT RAISE(ABORT, 'restaurant_order_steps is append-only'); END;

CREATE TABLE `menu_availability_events` (
	`id` text PRIMARY KEY NOT NULL,
	`location_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`event` text NOT NULL,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_menu_availability_events_lookup` ON `menu_availability_events` (`location_id`,`entity_id`,`occurred_at`);
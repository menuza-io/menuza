ALTER TABLE `pos_devices` ADD `timeclock_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_devices` ADD `reservations_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_pairing_codes` ADD `timeclock_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pos_pairing_codes` ADD `reservations_enabled` integer DEFAULT false NOT NULL;
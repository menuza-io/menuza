ALTER TABLE `pos_zatca_units` ADD `seller` text;--> statement-breakpoint
ALTER TABLE `pos_zatca_units` ADD `auth_failed_at` integer;--> statement-breakpoint
ALTER TABLE `pos_zatca_units` ADD `revoked_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pos_zatca_submissions_counter` ON `pos_zatca_submissions` (`device_id`,`counter`);
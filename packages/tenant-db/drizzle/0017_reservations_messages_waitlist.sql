ALTER TABLE `rsv_day_versions` ADD `availability_increased_at` integer;--> statement-breakpoint
ALTER TABLE `rsv_outbox` ADD `status` text DEFAULT 'pending' NOT NULL;

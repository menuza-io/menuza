ALTER TABLE `marketing_campaigns` ADD `dispatch_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sms_send_events_at` ON `sms_send_events` (`at`);
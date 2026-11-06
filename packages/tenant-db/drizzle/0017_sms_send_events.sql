CREATE TABLE `sms_send_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`phone_hash` text NOT NULL,
	`ip_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sms_send_events_kind_at` ON `sms_send_events` (`kind`,`at`);--> statement-breakpoint
CREATE INDEX `idx_sms_send_events_phone_at` ON `sms_send_events` (`phone_hash`,`at`);--> statement-breakpoint
CREATE INDEX `idx_sms_send_events_ip_at` ON `sms_send_events` (`ip_hash`,`at`);
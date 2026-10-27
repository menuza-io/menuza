CREATE TABLE `qr_tab_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`tab_id` text NOT NULL,
	`session_id` text NOT NULL,
	`processor` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`received_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`tab_id`) REFERENCES `qr_tabs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qr_tab_payments_session_unique` ON `qr_tab_payments` (`processor`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_qr_tab_payments_tab` ON `qr_tab_payments` (`tab_id`);--> statement-breakpoint
CREATE TRIGGER `qr_tab_payments_no_update` BEFORE UPDATE ON `qr_tab_payments`
BEGIN
	SELECT RAISE(ABORT, 'qr_tab_payments is append-only');
END;

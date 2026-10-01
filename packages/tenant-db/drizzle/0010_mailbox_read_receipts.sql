CREATE TABLE `mailbox_read_receipts` (
	`submission_id` text NOT NULL,
	`operator_id` text NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`submission_id`, `operator_id`),
	FOREIGN KEY (`submission_id`) REFERENCES `website_form_submissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mailbox_read_receipts_operator` ON `mailbox_read_receipts` (`operator_id`);
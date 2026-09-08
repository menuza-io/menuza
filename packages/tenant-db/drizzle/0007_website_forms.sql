CREATE TABLE `website_form_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`values` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	FOREIGN KEY (`form_id`) REFERENCES `website_forms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_website_form_submissions_form_created` ON `website_form_submissions` (`form_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `website_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`fields` text DEFAULT '[]' NOT NULL,
	`submit_label` text DEFAULT 'Submit' NOT NULL,
	`success_message` text DEFAULT 'Thank you. Your response has been received.' NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')),
	`updated_at` integer DEFAULT (strftime('%s', 'now'))
);
--> statement-breakpoint
CREATE INDEX `idx_website_forms_status` ON `website_forms` (`status`);

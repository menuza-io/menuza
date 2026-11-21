CREATE TABLE `guest_photo_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text,
	`order_id` text,
	`item_id` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`consent_text` text,
	`consent_version` text,
	`consented_at` integer,
	`decided_at` integer,
	`decided_by_user_id` text,
	`added_at` integer,
	`created_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_guest_photo_submissions_customer` ON `guest_photo_submissions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_guest_photo_submissions_org_customer_created` ON `guest_photo_submissions` (`org_id`,`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_guest_photo_submissions_order_item` ON `guest_photo_submissions` (`order_id`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_guest_photo_submissions_status_decided` ON `guest_photo_submissions` (`status`,`decided_at`);--> statement-breakpoint
CREATE INDEX `idx_guest_photo_submissions_status_created` ON `guest_photo_submissions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_guest_photo_submissions_org_status_created` ON `guest_photo_submissions` (`org_id`,`status`,`created_at`);
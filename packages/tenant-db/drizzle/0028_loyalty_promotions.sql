CREATE TABLE `loyalty_journey_emissions` (
	`member_id` text NOT NULL,
	`trigger` text NOT NULL,
	`ref` text NOT NULL,
	`state` text DEFAULT 'fired' NOT NULL,
	`emitted_at` integer DEFAULT (cast(strftime('%s', 'now') as integer) * 1000) NOT NULL,
	PRIMARY KEY(`member_id`, `trigger`, `ref`),
	FOREIGN KEY (`member_id`) REFERENCES `loyalty_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `loyalty_purchases` ADD `bonus_points` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `loyalty_purchases` ADD `applied_promotions` text;
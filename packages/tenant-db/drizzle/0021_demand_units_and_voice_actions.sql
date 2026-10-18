CREATE TABLE `voice_call_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`call_id` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`call_id`) REFERENCES `voice_calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_voice_call_actions_call_action` ON `voice_call_actions` (`call_id`,`action`);--> statement-breakpoint
ALTER TABLE `labor_scope_settings` ADD `demand_per_labor_hour` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE `labor_scope_settings` SET `demand_per_labor_hour` = json_object('orders', json(`orders_per_labor_hour`));

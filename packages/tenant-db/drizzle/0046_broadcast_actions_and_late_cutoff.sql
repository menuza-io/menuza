CREATE TABLE `marketing_test_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_id` text NOT NULL,
	`channel` text NOT NULL,
	`sent_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_marketing_test_sends_operator` ON `marketing_test_sends` (`operator_id`,`sent_at`);--> statement-breakpoint
ALTER TABLE `marketing_campaigns` ADD `late_after_minutes` integer DEFAULT 240 NOT NULL;--> statement-breakpoint
ALTER TABLE `marketing_campaigns` ADD `retarget_of_campaign_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_marketing_campaigns_retarget_of` ON `marketing_campaigns` (`retarget_of_campaign_id`) WHERE "marketing_campaigns"."retarget_of_campaign_id" IS NOT NULL;
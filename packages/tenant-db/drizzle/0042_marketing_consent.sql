ALTER TABLE `customer_subscriptions` ADD `consent_text_version` text;--> statement-breakpoint
ALTER TABLE `customer_subscriptions` ADD `recorded_by` text;--> statement-breakpoint
ALTER TABLE `customer_subscriptions` ADD `consent_method` text;--> statement-breakpoint
ALTER TABLE `customer_subscriptions` ADD `unsubscribed_source` text;
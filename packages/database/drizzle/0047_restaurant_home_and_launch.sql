CREATE TABLE `HomeAttentionDismissal` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`organizationId` text NOT NULL,
	`key` text NOT NULL,
	`dismissedUntil` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `HomeAttentionDismissal_user_org_key_key` ON `HomeAttentionDismissal` (`userId`,`organizationId`,`key`);--> statement-breakpoint
CREATE INDEX `HomeAttentionDismissal_organizationId_idx` ON `HomeAttentionDismissal` (`organizationId`);--> statement-breakpoint
DROP INDEX `OnboardingStepProgress_userId_organizationId_stepId_key`;--> statement-breakpoint
ALTER TABLE `OnboardingStepProgress` ADD `locationId` text REFERENCES OrganizationLocation(id) ON UPDATE cascade ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `OnboardingStepProgress` ADD `skippedAt` integer;--> statement-breakpoint
ALTER TABLE `OnboardingStepProgress` ADD `skipReason` text;--> statement-breakpoint
CREATE UNIQUE INDEX `OnboardingStepProgress_organizationId_locationId_stepId_key` ON `OnboardingStepProgress` (`organizationId`,`locationId`,`stepId`) WHERE `locationId` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `OnboardingStepProgress_userId_organizationId_stepId_key` ON `OnboardingStepProgress` (`userId`,`organizationId`,`stepId`) WHERE `locationId` IS NULL;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `liveAt` integer;
--> statement-breakpoint
INSERT INTO "OnboardingStep" ("id", "key", "title", "description", "icon", "actionConfig", "isActive", "sortOrder", "autoDetect", "detectConfig", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch_location_details', 'Add the address, phone and opening hours', 'Guests need to know where you are and when you are open.', 'map-pin', '{"type": "navigate", "target": "/settings/locations", "label": "Open"}', 1, 101, 0, '{"condition": "locationHasHours"}', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingStep" WHERE "key" = 'launch_location_details');--> statement-breakpoint
INSERT INTO "OnboardingStep" ("id", "key", "title", "description", "icon", "actionConfig", "isActive", "sortOrder", "autoDetect", "detectConfig", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch_menu', 'Build your menu', 'At least one category with 5 or more priced items, and a menu health score of 60 or more.', 'book-open', '{"type": "navigate", "target": "/menu", "label": "Open"}', 1, 102, 0, '{"condition": "menuReady"}', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingStep" WHERE "key" = 'launch_menu');--> statement-breakpoint
INSERT INTO "OnboardingStep" ("id", "key", "title", "description", "icon", "actionConfig", "isActive", "sortOrder", "autoDetect", "detectConfig", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch_branding', 'Upload a logo and pick the site theme', 'Your site should look like your restaurant.', 'palette', '{"type": "navigate", "target": "/website", "label": "Open"}', 1, 103, 0, '{"condition": "brandingDone"}', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingStep" WHERE "key" = 'launch_branding');--> statement-breakpoint
INSERT INTO "OnboardingStep" ("id", "key", "title", "description", "icon", "actionConfig", "isActive", "sortOrder", "autoDetect", "detectConfig", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch_payments', 'Connect payments or choose pay at pickup', 'Take card payments online, or let guests pay when they collect.', 'credit-card', '{"type": "navigate", "target": "/settings/payments", "label": "Open"}', 1, 104, 0, '{"condition": "paymentsReady"}', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingStep" WHERE "key" = 'launch_payments');--> statement-breakpoint
INSERT INTO "OnboardingStep" ("id", "key", "title", "description", "icon", "actionConfig", "isActive", "sortOrder", "autoDetect", "detectConfig", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch_fulfillment', 'Set pickup, delivery and prep time', 'Tell guests how they get their food and how long it takes.', 'truck', '{"type": "navigate", "target": "/settings/locations", "label": "Open"}', 1, 105, 0, '{"condition": "fulfillmentReady"}', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingStep" WHERE "key" = 'launch_fulfillment');--> statement-breakpoint
INSERT INTO "OnboardingStep" ("id", "key", "title", "description", "icon", "actionConfig", "isActive", "sortOrder", "autoDetect", "detectConfig", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch_station', 'Pair a Station terminal or kitchen display', 'Optional: see and run online orders on a tablet.', 'monitor', '{"type": "navigate", "target": "/settings/terminals", "label": "Open"}', 1, 106, 0, '{"condition": "terminalPaired"}', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingStep" WHERE "key" = 'launch_station');--> statement-breakpoint
INSERT INTO "OnboardingStep" ("id", "key", "title", "description", "icon", "actionConfig", "isActive", "sortOrder", "autoDetect", "detectConfig", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch_test_order', 'Place a test order', 'Optional: check the whole order flow before guests do.', 'shopping-bag', '{"type": "navigate", "target": "/menu", "label": "Open"}', 1, 107, 0, '{"condition": "testOrderDone"}', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingStep" WHERE "key" = 'launch_test_order');--> statement-breakpoint
INSERT INTO "OnboardingStep" ("id", "key", "title", "description", "icon", "actionConfig", "isActive", "sortOrder", "autoDetect", "detectConfig", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch_custom_domain', 'Connect a custom domain', 'Optional: use your own web address.', 'globe', '{"type": "navigate", "target": "/website/domain", "label": "Open"}', 1, 108, 0, '{"condition": "customDomainActive"}', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingStep" WHERE "key" = 'launch_custom_domain');--> statement-breakpoint
INSERT INTO "OnboardingStep" ("id", "key", "title", "description", "icon", "actionConfig", "isActive", "sortOrder", "autoDetect", "detectConfig", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch_go_live', 'Publish your site and turn on online ordering', 'The last step: guests can order.', 'rocket', '{"type": "navigate", "target": "/website", "label": "Open"}', 1, 109, 0, '{"condition": "siteLive"}', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "OnboardingStep" WHERE "key" = 'launch_go_live');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'launch.checklist', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'launch.checklist' AND "level" = 'system');

CREATE TABLE `WebsiteImport` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`sourceUrl` text NOT NULL,
	`status` text DEFAULT 'found' NOT NULL,
	`stats` text,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `WebsiteImport_organizationId_idx` ON `WebsiteImport` (`organizationId`);--> statement-breakpoint
CREATE TABLE `WebsiteImportPage` (
	`id` text PRIMARY KEY NOT NULL,
	`importId` text NOT NULL,
	`url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`extracted` text,
	`proposedSections` text,
	`status` text DEFAULT 'found' NOT NULL,
	`skipReason` text,
	`pageId` text,
	`redirectTo` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`importId`) REFERENCES `WebsiteImport`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`pageId`) REFERENCES `WebsitePage`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `WebsiteImportPage_importId_idx` ON `WebsiteImportPage` (`importId`);--> statement-breakpoint
CREATE UNIQUE INDEX `WebsiteImportPage_importId_url_key` ON `WebsiteImportPage` (`importId`,`url`);--> statement-breakpoint
CREATE TABLE `WebsiteSiteGeneration` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `WebsiteSiteGeneration_organizationId_createdAt_idx` ON `WebsiteSiteGeneration` (`organizationId`,`createdAt`);--> statement-breakpoint
ALTER TABLE `WebsitePage` ADD `generatedBy` text;--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'website.ai_generate', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'website.ai_generate' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'website.import', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'website.import' AND "level" = 'system');
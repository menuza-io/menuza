CREATE TABLE `IndexNowPing` (
	`organizationId` text NOT NULL,
	`url` text NOT NULL,
	`lastPingedAt` integer NOT NULL,
	PRIMARY KEY(`organizationId`, `url`),
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `SearchConsoleDaily` (
	`organizationId` text NOT NULL,
	`date` text NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	`impressions` integer DEFAULT 0 NOT NULL,
	`position` real,
	PRIMARY KEY(`organizationId`, `date`),
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `SearchConsoleTop` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`clicks` integer DEFAULT 0 NOT NULL,
	`impressions` integer DEFAULT 0 NOT NULL,
	`position` real,
	`fetchedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `SearchConsoleTop_organizationId_kind_idx` ON `SearchConsoleTop` (`organizationId`,`kind`);--> statement-breakpoint
CREATE TABLE `SeoKeyword` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`phrase` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`isPrimary` integer DEFAULT false NOT NULL,
	`pageRef` text,
	`createdAt` integer NOT NULL,
	`deletedAt` integer,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `SeoKeyword_organizationId_idx` ON `SeoKeyword` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `SeoKeyword_location_phrase_key` ON `SeoKeyword` (`organizationLocationId`,`phrase`) WHERE "SeoKeyword"."deletedAt" IS NULL;--> statement-breakpoint
CREATE TABLE `SeoRankCheck` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`keywordId` text NOT NULL,
	`checkedAt` integer NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`reason` text,
	`gridSize` integer DEFAULT 5 NOT NULL,
	`spacingMeters` integer DEFAULT 1000 NOT NULL,
	`averageRank` real,
	`points` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`keywordId`) REFERENCES `SeoKeyword`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `SeoRankCheck_keywordId_checkedAt_idx` ON `SeoRankCheck` (`keywordId`,`checkedAt`);--> statement-breakpoint
CREATE INDEX `SeoRankCheck_organizationId_idx` ON `SeoRankCheck` (`organizationId`);--> statement-breakpoint
CREATE TABLE `SeoUsage` (
	`organizationId` text NOT NULL,
	`month` text NOT NULL,
	`checks` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`organizationId`, `month`),
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `SiteAreaPage` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`zoneId` text NOT NULL,
	`slug` text NOT NULL,
	`intro` text,
	`enabled` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `SiteAreaPage_organizationId_slug_key` ON `SiteAreaPage` (`organizationId`,`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `SiteAreaPage_location_zone_key` ON `SiteAreaPage` (`organizationLocationId`,`zoneId`);--> statement-breakpoint
CREATE TABLE `SiteEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text,
	`slug` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`imageUrl` text,
	`linkUrl` text,
	`linkLabel` text,
	`experienceId` text,
	`startLocal` text NOT NULL,
	`endLocal` text NOT NULL,
	`timezone` text NOT NULL,
	`recurrence` text DEFAULT '{"frequency":"none"}' NOT NULL,
	`exceptions` text DEFAULT '{"skipped":[],"moved":[]}' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `SiteEvent_organizationId_slug_key` ON `SiteEvent` (`organizationId`,`slug`);--> statement-breakpoint
CREATE INDEX `SiteEvent_organizationId_status_idx` ON `SiteEvent` (`organizationId`,`status`);--> statement-breakpoint
ALTER TABLE `Organization` ADD `cuisines` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD `priceRange` integer;--> statement-breakpoint
ALTER TABLE `Organization` ADD `googleSiteVerification` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD `bingSiteVerification` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD `indexNowKey` text;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `cuisines` text;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `priceRange` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `sitePageEnabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `siteIntro` text;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `siteSeoTitle` text;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `siteSeoDescription` text;--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `sitePageEnabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `siteSlug` text;--> statement-breakpoint
ALTER TABLE `WebsiteRedirect` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `WebsiteRedirect` ADD `pageId` text REFERENCES WebsitePage(id) ON UPDATE cascade ON DELETE set null;--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'seo.rank_tracking', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'seo.rank_tracking' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'seo.search_console', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'seo.search_console' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'website.events', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'website.events' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'website.location_pages', 'true', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'website.location_pages' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'website.dish_pages', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'website.dish_pages' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'website.area_pages', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'website.area_pages' AND "level" = 'system');

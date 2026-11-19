CREATE TABLE `GbpDailyMetric` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`date` text NOT NULL,
	`metric` text NOT NULL,
	`value` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `GbpDailyMetric_location_date_metric_key` ON `GbpDailyMetric` (`organizationLocationId`,`date`,`metric`);--> statement-breakpoint
CREATE INDEX `GbpDailyMetric_organizationId_date_idx` ON `GbpDailyMetric` (`organizationId`,`date`);--> statement-breakpoint
CREATE TABLE `GbpListingIssue` (
	`id` text PRIMARY KEY NOT NULL,
	`syncId` text NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`field` text NOT NULL,
	`menuzaValue` text,
	`googleValue` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolvedById` text,
	`resolvedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`syncId`) REFERENCES `GbpLocationSync`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`resolvedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `GbpListingIssue_syncId_field_idx` ON `GbpListingIssue` (`syncId`,`field`);--> statement-breakpoint
CREATE INDEX `GbpListingIssue_organizationId_status_idx` ON `GbpListingIssue` (`organizationId`,`status`);--> statement-breakpoint
CREATE TABLE `GbpLocationSync` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`integrationId` text,
	`googleLocationName` text NOT NULL,
	`googleAccountName` text,
	`syncEnabled` integer DEFAULT false NOT NULL,
	`fieldsSynced` text NOT NULL,
	`state` text DEFAULT 'ok' NOT NULL,
	`lastPulledAt` integer,
	`lastPushedAt` integer,
	`lastGoogleSnapshot` text,
	`lastError` text,
	`fieldState` text,
	`pushRequestedAt` integer,
	`orderLinkPausedAt` integer,
	`verificationState` text DEFAULT 'unknown' NOT NULL,
	`verificationMethod` text,
	`verificationDestination` text,
	`verificationName` text,
	`verificationRequestedAt` integer,
	`verificationCheckedAt` integer,
	`verificationOptions` text,
	`menuSyncEnabled` integer DEFAULT false NOT NULL,
	`menuDirtyAt` integer,
	`menuPublishedAt` integer,
	`menuAttemptedAt` integer,
	`menuHash` text,
	`menuPublishResult` text,
	`metricsBackfilledAt` integer,
	`metricsDataUntil` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`integrationId`) REFERENCES `Integration`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `GbpLocationSync_organizationLocationId_key` ON `GbpLocationSync` (`organizationLocationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `GbpLocationSync_googleLocationName_key` ON `GbpLocationSync` (`googleLocationName`);--> statement-breakpoint
CREATE INDEX `GbpLocationSync_organizationId_idx` ON `GbpLocationSync` (`organizationId`);--> statement-breakpoint
CREATE TABLE `GbpSearchKeyword` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`month` text NOT NULL,
	`keyword` text NOT NULL,
	`value` integer,
	`threshold` integer,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `GbpSearchKeyword_location_month_keyword_key` ON `GbpSearchKeyword` (`organizationLocationId`,`month`,`keyword`);--> statement-breakpoint
CREATE TABLE `GbpSyncEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`syncId` text,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`kind` text NOT NULL,
	`field` text,
	`actorId` text,
	`summary` text NOT NULL,
	`request` text,
	`result` text NOT NULL,
	`response` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`syncId`) REFERENCES `GbpLocationSync`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `GbpSyncEvent_organizationLocationId_createdAt_idx` ON `GbpSyncEvent` (`organizationLocationId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `GoogleMediaUpload` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`mediaId` text NOT NULL,
	`category` text NOT NULL,
	`remoteName` text,
	`status` text DEFAULT 'chosen' NOT NULL,
	`reason` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `GoogleMediaUpload_location_media_category_key` ON `GoogleMediaUpload` (`organizationLocationId`,`mediaId`,`category`);--> statement-breakpoint
CREATE TABLE `GoogleProfileField` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`source` text DEFAULT 'hand' NOT NULL,
	`status` text DEFAULT 'saved' NOT NULL,
	`reason` text,
	`pendingSince` integer,
	`updatedById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `GoogleProfileField_location_key_key` ON `GoogleProfileField` (`organizationLocationId`,`key`);--> statement-breakpoint
CREATE TABLE `ListingOrderLink` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`provider` text NOT NULL,
	`classification` text NOT NULL,
	`isPreferred` integer DEFAULT false NOT NULL,
	`googleLinkName` text,
	`googleProviderType` text,
	`editable` integer DEFAULT true NOT NULL,
	`state` text DEFAULT 'current' NOT NULL,
	`changeId` text,
	`checkedAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ListingOrderLink_location_state_idx` ON `ListingOrderLink` (`organizationLocationId`,`state`);--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `temporarilyClosed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `temporarilyClosedUntil` integer;--> statement-breakpoint
ALTER TABLE `SocialAccount` ADD `organizationLocationId` text REFERENCES OrganizationLocation(id);--> statement-breakpoint
ALTER TABLE `SocialPost` ADD `googleTopicType` text;--> statement-breakpoint
ALTER TABLE `SocialPost` ADD `googleDetails` text;--> statement-breakpoint
ALTER TABLE `SocialPostTarget` ADD `reviewState` text;--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'gbp.sync', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'gbp.sync' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'gbp.write', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'gbp.write' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'gbp.insights', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'gbp.insights' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'social.google', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'social.google' AND "level" = 'system');

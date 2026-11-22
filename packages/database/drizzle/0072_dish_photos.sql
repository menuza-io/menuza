CREATE TABLE `MediaRestyleRun` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`createdById` text,
	`style` text NOT NULL,
	`categoryIds` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`resumeAt` integer,
	`completedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `MediaRestyleRun_organizationId_status_idx` ON `MediaRestyleRun` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `MediaRestyleRun_organizationId_createdAt_idx` ON `MediaRestyleRun` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `MediaRestyleRun_status_idx` ON `MediaRestyleRun` (`status`);--> statement-breakpoint
CREATE TABLE `MediaRestyleRunItem` (
	`id` text PRIMARY KEY NOT NULL,
	`runId` text NOT NULL,
	`organizationId` text NOT NULL,
	`itemId` text NOT NULL,
	`sourceAssetKey` text,
	`sourceAssetId` text,
	`draftAssetId` text,
	`draftObjectKey` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision` text,
	`skipReason` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`replacedAssetKey` text,
	`processedAt` integer,
	`decidedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`runId`) REFERENCES `MediaRestyleRun`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`itemId`) REFERENCES `OrganizationMenuItem`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`sourceAssetId`) REFERENCES `OrganizationMediaAsset`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`draftAssetId`) REFERENCES `OrganizationMediaAsset`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `MediaRestyleRunItem_runId_itemId_key` ON `MediaRestyleRunItem` (`runId`,`itemId`);--> statement-breakpoint
CREATE INDEX `MediaRestyleRunItem_runId_status_idx` ON `MediaRestyleRunItem` (`runId`,`status`);--> statement-breakpoint
CREATE INDEX `MediaRestyleRunItem_organizationId_processedAt_idx` ON `MediaRestyleRunItem` (`organizationId`,`processedAt`);--> statement-breakpoint
CREATE INDEX `MediaRestyleRunItem_draftAssetId_idx` ON `MediaRestyleRunItem` (`draftAssetId`);--> statement-breakpoint
CREATE TABLE `MenuItemPhotoTest` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`itemId` text NOT NULL,
	`imageKeyA` text NOT NULL,
	`imageKeyB` text NOT NULL,
	`createdById` text,
	`startedAt` integer NOT NULL,
	`endedAt` integer,
	`winner` text,
	`endedReason` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`itemId`) REFERENCES `OrganizationMenuItem`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `MenuItemPhotoTest_organizationId_endedAt_idx` ON `MenuItemPhotoTest` (`organizationId`,`endedAt`);--> statement-breakpoint
CREATE INDEX `MenuItemPhotoTest_itemId_idx` ON `MenuItemPhotoTest` (`itemId`);--> statement-breakpoint
CREATE UNIQUE INDEX `MenuItemPhotoTest_itemId_running_key` ON `MenuItemPhotoTest` (`itemId`) WHERE "MenuItemPhotoTest"."endedAt" IS NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMediaAsset` ADD `focalX` real;--> statement-breakpoint
ALTER TABLE `OrganizationMediaAsset` ADD `focalY` real;--> statement-breakpoint
ALTER TABLE `OrganizationMediaAsset` ADD `qualityScore` integer;--> statement-breakpoint
ALTER TABLE `OrganizationMediaAsset` ADD `qualityIssues` text;--> statement-breakpoint
ALTER TABLE `OrganizationMediaAsset` ADD `qualityAttempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMediaAsset` ADD `analyzedAt` integer;--> statement-breakpoint
CREATE INDEX `OrganizationMediaAsset_organizationId_analyzedAt_idx` ON `OrganizationMediaAsset` (`organizationId`,`analyzedAt`);--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'media.photo_quality', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'media.photo_quality' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'media.restyle', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'media.restyle' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'menu.photo_tests', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'menu.photo_tests' AND "level" = 'system');
--> statement-breakpoint
UPDATE `OrganizationMediaAsset` SET `source` = 'guest-photo' WHERE `source` = 'library' AND substr(`fileName`, 1, 12) = 'guest-photo-';

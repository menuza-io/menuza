CREATE TABLE `FontLicenceAcceptance` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`agreementVersion` integer NOT NULL,
	`role` text NOT NULL,
	`fileName` text NOT NULL,
	`fileHash` text NOT NULL,
	`objectKey` text NOT NULL,
	`acceptedAt` integer NOT NULL,
	`removedAt` integer,
	`removedBy` text,
	`removedByUserId` text,
	`removedReason` text,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `FontLicenceAcceptance_organizationId_acceptedAt_idx` ON `FontLicenceAcceptance` (`organizationId`,`acceptedAt`);--> statement-breakpoint
CREATE INDEX `FontLicenceAcceptance_org_user_version_idx` ON `FontLicenceAcceptance` (`organizationId`,`userId`,`agreementVersion`);--> statement-breakpoint
CREATE TABLE `HeroVideoGeneration` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`requestedById` text,
	`style` text NOT NULL,
	`photoAssetIds` text NOT NULL,
	`selection` text DEFAULT 'picked' NOT NULL,
	`pageId` text,
	`durationSeconds` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`videoAssetId` text,
	`posterAssetId` text,
	`error` text,
	`startedAt` integer,
	`completedAt` integer,
	`acceptedAt` integer,
	`acceptedById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`videoAssetId`) REFERENCES `OrganizationMediaAsset`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`posterAssetId`) REFERENCES `OrganizationMediaAsset`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `HeroVideoGeneration_organizationId_createdAt_idx` ON `HeroVideoGeneration` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `HeroVideoGeneration_status_idx` ON `HeroVideoGeneration` (`status`);--> statement-breakpoint
CREATE TABLE `OrganizationMediaTag` (
	`assetId` text NOT NULL,
	`organizationId` text NOT NULL,
	`tag` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`assetId`) REFERENCES `OrganizationMediaAsset`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMediaTag_assetId_tag_key` ON `OrganizationMediaTag` (`assetId`,`tag`);--> statement-breakpoint
CREATE INDEX `OrganizationMediaTag_organizationId_tag_idx` ON `OrganizationMediaTag` (`organizationId`,`tag`);--> statement-breakpoint
CREATE TABLE `SiteEventCalendarSource` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`organizationLocationId` text,
	`label` text NOT NULL,
	`urlEncrypted` text NOT NULL,
	`urlHint` text NOT NULL,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`lastError` text,
	`lastSyncedAt` integer,
	`nextSyncAt` integer,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationLocationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `SiteEventCalendarSource_organizationId_idx` ON `SiteEventCalendarSource` (`organizationId`);--> statement-breakpoint
CREATE INDEX `SiteEventCalendarSource_nextSyncAt_idx` ON `SiteEventCalendarSource` (`nextSyncAt`);--> statement-breakpoint
ALTER TABLE `Organization` ADD `actionTargets` text;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `actionTargets` text;--> statement-breakpoint
ALTER TABLE `OrganizationMediaAsset` ADD `archivedAt` integer;--> statement-breakpoint
ALTER TABLE `OrganizationMediaAsset` ADD `status` text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMediaAsset` ADD `parentAssetId` text REFERENCES OrganizationMediaAsset(id) ON UPDATE cascade ON DELETE set null;--> statement-breakpoint
CREATE INDEX `OrganizationMediaAsset_parentAssetId_idx` ON `OrganizationMediaAsset` (`parentAssetId`);--> statement-breakpoint
ALTER TABLE `SiteEvent` ADD `sourceId` text REFERENCES SiteEventCalendarSource(id) ON UPDATE cascade ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `SiteEvent` ADD `sourceKey` text;--> statement-breakpoint
CREATE UNIQUE INDEX `SiteEvent_sourceId_sourceKey_key` ON `SiteEvent` (`sourceId`,`sourceKey`) WHERE "SiteEvent"."sourceId" IS NOT NULL;
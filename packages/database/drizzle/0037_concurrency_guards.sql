-- Rollout note: this migration deletes duplicate ConfigFlag rows (the most
-- recently updated one is kept) and duplicate PlatformMarketingMessage rows
-- before it adds unique indexes. Removed PlatformMarketingMessage rows are
-- copied to `__archived_PlatformMarketingMessage_0027` first. See
-- docs/platform-marketing-email.md, "Migration archives".
CREATE TABLE `StaffingAlertEmail` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`eventId` text NOT NULL,
	`userId` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `StaffingAlertEmail_organizationId_eventId_userId_key` ON `StaffingAlertEmail` (`organizationId`,`eventId`,`userId`);--> statement-breakpoint
CREATE INDEX `StaffingAlertEmail_userId_idx` ON `StaffingAlertEmail` (`userId`);--> statement-breakpoint
CREATE TABLE `StorageMigrationItem` (
	`id` text PRIMARY KEY NOT NULL,
	`migrationId` text NOT NULL,
	`objectKey` text NOT NULL,
	`contentType` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`migrationId`) REFERENCES `StorageMigration`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `StorageMigrationItem_migrationId_objectKey_key` ON `StorageMigrationItem` (`migrationId`,`objectKey`);--> statement-breakpoint
CREATE INDEX `StorageMigrationItem_migrationId_status_idx` ON `StorageMigrationItem` (`migrationId`,`status`);--> statement-breakpoint
-- Rebuilding a table is the only way SQLite changes a foreign key. Migrations
-- run in a transaction (D1 and the LibSQL migrator), where foreign_keys cannot
-- be turned off: dropping a parent table runs its ON DELETE CASCADE actions.
-- Checks are deferred to the commit, and the one cascading child
-- (WebsitePageSection) is copied aside and restored below.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_OrganizationInviteLink` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`organizationRoleId` text NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`organizationId` text NOT NULL,
	`createdById` text NOT NULL,
	FOREIGN KEY (`organizationRoleId`) REFERENCES `OrganizationRole`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_OrganizationInviteLink`("id", "token", "organizationRoleId", "isActive", "createdAt", "updatedAt", "organizationId", "createdById") SELECT "id", "token", "organizationRoleId", "isActive", "createdAt", "updatedAt", "organizationId", "createdById" FROM `OrganizationInviteLink`;--> statement-breakpoint
DROP TABLE `OrganizationInviteLink`;--> statement-breakpoint
ALTER TABLE `__new_OrganizationInviteLink` RENAME TO `OrganizationInviteLink`;--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationInviteLink_organizationId_createdById_key` ON `OrganizationInviteLink` (`organizationId`,`createdById`);--> statement-breakpoint
CREATE INDEX `OrganizationInviteLink_organizationRoleId_idx` ON `OrganizationInviteLink` (`organizationRoleId`);--> statement-breakpoint
CREATE INDEX `OrganizationInviteLink_createdById_idx` ON `OrganizationInviteLink` (`createdById`);--> statement-breakpoint
CREATE INDEX `OrganizationInviteLink_organizationId_idx` ON `OrganizationInviteLink` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationInviteLink_token_key` ON `OrganizationInviteLink` (`token`);--> statement-breakpoint
-- Dropping the table dropped its triggers (from 0012); recreate them.
CREATE TRIGGER `OrganizationInviteLink_organizationRole_same_organization_insert`
BEFORE INSERT ON `OrganizationInviteLink`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `OrganizationRole`
	WHERE `id` = NEW.`organizationRoleId`
		AND `organizationId` IS NOT NULL
		AND `organizationId` <> NEW.`organizationId`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END;--> statement-breakpoint
CREATE TRIGGER `OrganizationInviteLink_organizationRole_same_organization_update`
BEFORE UPDATE OF `organizationRoleId`, `organizationId` ON `OrganizationInviteLink`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `OrganizationRole`
	WHERE `id` = NEW.`organizationRoleId`
		AND `organizationId` IS NOT NULL
		AND `organizationId` <> NEW.`organizationId`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END;--> statement-breakpoint
CREATE TABLE `__bak_WebsitePageSection` AS SELECT * FROM `WebsitePageSection`;--> statement-breakpoint
CREATE TABLE `__new_WebsitePage` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`template` text DEFAULT 'blank' NOT NULL,
	`isHomePage` integer DEFAULT false NOT NULL,
	`position` real,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`createdById` text,
	`seoTitle` text,
	`seoDescription` text,
	`seoImageUrl` text,
	`seoNoIndex` integer DEFAULT false NOT NULL,
	`publishedData` text,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_WebsitePage`("id", "organizationId", "title", "slug", "status", "template", "isHomePage", "position", "createdAt", "updatedAt", "createdById", "seoTitle", "seoDescription", "seoImageUrl", "seoNoIndex", "publishedData") SELECT "id", "organizationId", "title", "slug", "status", "template", "isHomePage", "position", "createdAt", "updatedAt", "createdById", "seoTitle", "seoDescription", "seoImageUrl", "seoNoIndex", "publishedData" FROM `WebsitePage`;--> statement-breakpoint
DROP TABLE `WebsitePage`;--> statement-breakpoint
ALTER TABLE `__new_WebsitePage` RENAME TO `WebsitePage`;--> statement-breakpoint
CREATE UNIQUE INDEX `WebsitePage_organizationId_slug_key` ON `WebsitePage` (`organizationId`,`slug`);--> statement-breakpoint
CREATE INDEX `WebsitePage_organizationId_status_idx` ON `WebsitePage` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `WebsitePage_organizationId_idx` ON `WebsitePage` (`organizationId`);--> statement-breakpoint
INSERT INTO `WebsitePageSection` SELECT * FROM `__bak_WebsitePageSection`;--> statement-breakpoint
DROP TABLE `__bak_WebsitePageSection`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
DROP INDEX `ConfigFlag_key_level_organizationId_userId_key`;--> statement-breakpoint
-- Duplicate flags for one key and scope: keep the most recently updated.
DELETE FROM `ConfigFlag`
WHERE `rowid` NOT IN (
	SELECT `rowid` FROM (
		SELECT
			`rowid`,
			ROW_NUMBER() OVER (
				PARTITION BY `key`, `level`, coalesce(`organizationId`, ''), coalesce(`userId`, '')
				ORDER BY `updatedAt` DESC, `id` DESC
			) AS `rn`
		FROM `ConfigFlag`
	) AS `ranked`
	WHERE `rn` = 1
);--> statement-breakpoint
-- Written by hand: drizzle-kit splits the expressions at their commas.
CREATE UNIQUE INDEX `ConfigFlag_key_level_scope_key` ON `ConfigFlag` (`key`,`level`,coalesce(`organizationId`, ''),coalesce(`userId`, ''));--> statement-breakpoint
DROP INDEX `PlatformMarketingMessage_campaignId_idx`;--> statement-breakpoint
-- Two dispatches that both wrote a row for a user: keep the most engaged row
-- (Clicked, Opened, Sent, Processing (outcome unknown), then Failed; the
-- oldest on a tie). The others are copied to
-- `__archived_PlatformMarketingMessage_0027` before they are deleted, so the
-- deletion can be undone. Nothing references PlatformMarketingMessage.
CREATE TABLE `__archived_PlatformMarketingMessage_0027` AS
SELECT * FROM `PlatformMarketingMessage`
WHERE `rowid` IN (
	SELECT `rowid` FROM (
		SELECT
			`rowid`,
			ROW_NUMBER() OVER (
				PARTITION BY `campaignId`, `userId`
				ORDER BY
					CASE `status`
						WHEN 'Clicked' THEN 0
						WHEN 'Opened' THEN 1
						WHEN 'Sent' THEN 2
						WHEN 'Processing' THEN 3
						WHEN 'Failed' THEN 5
						ELSE 4
					END,
					`createdAt`,
					`rowid`
			) AS `rn`
		FROM `PlatformMarketingMessage`
	) AS `ranked`
	WHERE `rn` > 1
);--> statement-breakpoint
DELETE FROM `PlatformMarketingMessage`
WHERE `id` IN (SELECT `id` FROM `__archived_PlatformMarketingMessage_0027`);--> statement-breakpoint
CREATE UNIQUE INDEX `PlatformMarketingMessage_campaignId_userId_key` ON `PlatformMarketingMessage` (`campaignId`,`userId`);
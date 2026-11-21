CREATE TABLE `CustomerApp` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`slug` text NOT NULL,
	`displayName` text NOT NULL,
	`iosBundleId` text NOT NULL,
	`androidPackage` text NOT NULL,
	`marketingVersion` text DEFAULT '1.0.0' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`publisher` text DEFAULT 'menuza' NOT NULL,
	`iconBackground` text DEFAULT '#0F172A' NOT NULL,
	`listingText` text,
	`storeUrls` text,
	`appleTeamId` text,
	`androidSha256` text,
	`accountSnapshot` text,
	`accountCheckedAt` integer,
	`publishedAt` integer,
	`archivedAt` integer,
	`inviteBanner` integer DEFAULT true NOT NULL,
	`inviteConfirmation` integer DEFAULT true NOT NULL,
	`inviteFooter` integer DEFAULT true NOT NULL,
	`inviteBannerText` text DEFAULT '' NOT NULL,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `CustomerApp_organizationId_key` ON `CustomerApp` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `CustomerApp_slug_key` ON `CustomerApp` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `CustomerApp_iosBundleId_key` ON `CustomerApp` (`iosBundleId`);--> statement-breakpoint
CREATE UNIQUE INDEX `CustomerApp_androidPackage_key` ON `CustomerApp` (`androidPackage`);--> statement-breakpoint
CREATE TABLE `CustomerAppBuild` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`release` text NOT NULL,
	`platform` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`externalBuildId` text,
	`logUrl` text,
	`dataRegion` text DEFAULT 'us' NOT NULL,
	`error` text,
	`startedById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`finishedAt` integer,
	FOREIGN KEY (`appId`) REFERENCES `CustomerApp`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`startedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `CustomerAppBuild_appId_release_platform_key` ON `CustomerAppBuild` (`appId`,`release`,`platform`);--> statement-breakpoint
CREATE INDEX `CustomerAppBuild_appId_createdAt_idx` ON `CustomerAppBuild` (`appId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `CustomerAppCredential` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`kind` text NOT NULL,
	`ciphertext` text NOT NULL,
	`uploadedById` text,
	`uploadedAt` integer NOT NULL,
	FOREIGN KEY (`appId`) REFERENCES `CustomerApp`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`uploadedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `CustomerAppCredential_appId_kind_key` ON `CustomerAppCredential` (`appId`,`kind`);--> statement-breakpoint
CREATE TABLE `CustomerAppStoreHealth` (
	`appId` text NOT NULL,
	`store` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`version` text,
	`ratingX100` integer,
	`ratingCount` integer DEFAULT 0 NOT NULL,
	`lastCheckedAt` integer,
	`lastSuccessAt` integer,
	`lastError` text,
	PRIMARY KEY(`appId`, `store`),
	FOREIGN KEY (`appId`) REFERENCES `CustomerApp`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `CustomerAppStoreReview` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`store` text NOT NULL,
	`externalId` text NOT NULL,
	`rating` integer NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`appVersion` text,
	`reviewedAt` integer NOT NULL,
	FOREIGN KEY (`appId`) REFERENCES `CustomerApp`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `CustomerAppStoreReview_app_store_external_key` ON `CustomerAppStoreReview` (`appId`,`store`,`externalId`);--> statement-breakpoint
CREATE INDEX `CustomerAppStoreReview_appId_reviewedAt_idx` ON `CustomerAppStoreReview` (`appId`,`reviewedAt`);--> statement-breakpoint
CREATE TABLE `CustomerAppTap` (
	`appId` text NOT NULL,
	`placement` text NOT NULL,
	`store` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`appId`, `placement`, `store`, `day`),
	FOREIGN KEY (`appId`) REFERENCES `CustomerApp`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
-- Platform permission for Admin (#156): create apps, upload credentials, start
-- builds. System context (not an organization role): granted to the built-in
-- `admin` role when it exists. Restaurants never hold it; they see a read-only
-- card behind the organization flag customer_app.enabled.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('sys_perm_update_customer_app_any', 'update', 'customer_app', 'any', 'system', 'Manage branded customer apps: create, credentials, builds', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_PermissionToRole" ("A", "B")
SELECT 'sys_perm_update_customer_app_any', "Role"."id" FROM "Role" WHERE "Role"."name" = 'admin';--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'customer_app.enabled', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'customer_app.enabled' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'customer_app.push', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'customer_app.push' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'marketing.push', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'marketing.push' AND "level" = 'system');

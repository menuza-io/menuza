CREATE TABLE `MenuImport` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`sourceKind` text NOT NULL,
	`sourceUrl` text,
	`sourceKey` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`draftKey` text,
	`appliedAt` integer,
	`createdById` text,
	`confirmedOwnership` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `MenuImport_active_org_key` ON `MenuImport` (`organizationId`) WHERE "MenuImport"."status" IN ('queued', 'running', 'applying');--> statement-breakpoint
CREATE INDEX `MenuImport_organizationId_idx` ON `MenuImport` (`organizationId`);--> statement-breakpoint
CREATE INDEX `MenuImport_organizationId_createdAt_idx` ON `MenuImport` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `MenuSchedule` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`menuId` text NOT NULL,
	`goLiveAt` integer NOT NULL,
	`takeOffMenuId` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`menuId`) REFERENCES `OrganizationMenu`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`takeOffMenuId`) REFERENCES `OrganizationMenu`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `MenuSchedule_pending_menu_key` ON `MenuSchedule` (`menuId`) WHERE "MenuSchedule"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `MenuSchedule_organizationId_idx` ON `MenuSchedule` (`organizationId`);--> statement-breakpoint
CREATE INDEX `MenuSchedule_status_goLiveAt_idx` ON `MenuSchedule` (`status`,`goLiveAt`);--> statement-breakpoint
CREATE INDEX `MenuSchedule_takeOffMenuId_idx` ON `MenuSchedule` (`takeOffMenuId`);--> statement-breakpoint
ALTER TABLE `Organization` ADD `autoPopularCount` integer;--> statement-breakpoint
ALTER TABLE `OrganizationMenu` ADD `channels` text DEFAULT '["web","qr","pos","app"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMenuCategory` ADD `channels` text DEFAULT '["web","qr","pos","app"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `popularMode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
UPDATE "OrganizationMenuItem" SET "popularMode" = 'always' WHERE "isPopular" = true;--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `channels` text DEFAULT '["web","qr","pos","app"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMenuLocationOverride` ADD `channels` text;--> statement-breakpoint
-- Guest dish photo moderation (#148). Built-in admins (the owner's preset)
-- receive it by default; custom roles can be granted it in the role editor.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_update_guest_photo_any', 'update', 'guest_photo', 'any', 'organization', 'Moderate guest-submitted dish photos and add them to dishes', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_update_guest_photo_any');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'menu.auto_popular', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'menu.auto_popular' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'menu.guest_photos', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'menu.guest_photos' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'menu.import', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'menu.import' AND "level" = 'system');
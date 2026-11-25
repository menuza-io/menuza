CREATE TABLE `MenuSyncOutbox` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`integrationId` text NOT NULL,
	`kind` text NOT NULL,
	`entityType` text NOT NULL,
	`entityId` text DEFAULT '' NOT NULL,
	`payload` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`firstFailedAt` integer,
	`nextAttemptAt` integer NOT NULL,
	`lastError` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`integrationId`) REFERENCES `Integration`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `MenuSyncOutbox_queued_coalesce_key` ON `MenuSyncOutbox` (`integrationId`,`kind`,`entityType`,`entityId`) WHERE "MenuSyncOutbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX `MenuSyncOutbox_status_nextAttemptAt_idx` ON `MenuSyncOutbox` (`status`,`nextAttemptAt`);--> statement-breakpoint
CREATE INDEX `MenuSyncOutbox_organizationId_idx` ON `MenuSyncOutbox` (`organizationId`);--> statement-breakpoint
CREATE INDEX `MenuSyncOutbox_integrationId_status_idx` ON `MenuSyncOutbox` (`integrationId`,`status`);--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `email` text;--> statement-breakpoint
ALTER TABLE `OrganizationMenuPosLink` ADD `lastSyncedHash` text;--> statement-breakpoint
ALTER TABLE `OrganizationMenuPosLink` ADD `lastSyncedAt` integer;--> statement-breakpoint
ALTER TABLE `OrganizationMenuPosLink` ADD `posValues` text;--> statement-breakpoint
ALTER TABLE `OrganizationMenuPosLink` ADD `overriddenFields` text;--> statement-breakpoint
CREATE INDEX `OrganizationMenuPosLink_org_entity_local_idx` ON `OrganizationMenuPosLink` (`organizationId`,`entityType`,`localId`);--> statement-breakpoint
CREATE INDEX `IntegrationLog_integrationId_createdAt_idx` ON `IntegrationLog` (`integrationId`,`createdAt`);--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'integrations.pos_ownership', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'integrations.pos_ownership' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'integrations.auto_sync', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'integrations.auto_sync' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'integrations.delivery_pause', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'integrations.delivery_pause' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'integrations.store_settings', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'integrations.store_settings' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'integrations.menu_check', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'integrations.menu_check' AND "level" = 'system');
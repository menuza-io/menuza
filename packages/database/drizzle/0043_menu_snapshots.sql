CREATE TABLE `MenuSnapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`reason` text NOT NULL,
	`label` text,
	`createdById` text,
	`itemCount` integer DEFAULT 0 NOT NULL,
	`contentKey` text NOT NULL,
	`contentHash` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `MenuSnapshot_organizationId_idx` ON `MenuSnapshot` (`organizationId`);--> statement-breakpoint
CREATE INDEX `MenuSnapshot_organizationId_createdAt_idx` ON `MenuSnapshot` (`organizationId`,`createdAt`);--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'menu.history', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'menu.history' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'menu.bulk_edit', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'menu.bulk_edit' AND "level" = 'system');

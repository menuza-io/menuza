CREATE TABLE `MenuCheckDismissal` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`entityType` text NOT NULL,
	`entityId` text NOT NULL,
	`checkKey` text NOT NULL,
	`reason` text,
	`fingerprint` text DEFAULT '' NOT NULL,
	`createdById` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `MenuCheckDismissal_org_entity_check_key` ON `MenuCheckDismissal` (`organizationId`,`entityId`,`checkKey`);--> statement-breakpoint
CREATE INDEX `MenuCheckDismissal_organizationId_idx` ON `MenuCheckDismissal` (`organizationId`);--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'menu.structure_suggestions', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'menu.structure_suggestions' AND "level" = 'system');

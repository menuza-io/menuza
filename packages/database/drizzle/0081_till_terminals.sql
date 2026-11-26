ALTER TABLE `OrganizationLocation` ADD `fewLeftThreshold` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `barcode` text;--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuItem_org_barcode_key` ON `OrganizationMenuItem` (`organizationId`,`barcode`) WHERE "OrganizationMenuItem"."barcode" is not null;--> statement-breakpoint
ALTER TABLE `OrganizationMenuOption` ADD `barcode` text;--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuOption_org_barcode_key` ON `OrganizationMenuOption` (`organizationId`,`barcode`) WHERE "OrganizationMenuOption"."barcode" is not null;--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'inventory.few_left_online', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'inventory.few_left_online' AND "level" = 'system');
CREATE INDEX IF NOT EXISTS `OrganizationLocation_organizationId_idx` ON `OrganizationLocation` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `OrganizationLocation_organizationId_slug_key` ON `OrganizationLocation` (`organizationId`,`slug`);--> statement-breakpoint
ALTER TABLE `Organization` ADD COLUMN `brandStoreHoursJson` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD COLUMN `brandOnlineHoursJson` text;

CREATE TABLE `UserOrganizationLocation` (
	`userId` text NOT NULL,
	`organizationId` text NOT NULL,
	`locationId` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `organizationId`, `locationId`),
	FOREIGN KEY (`locationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`,`organizationId`) REFERENCES `UserOrganization`(`userId`,`organizationId`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `UserOrganizationLocation_locationId_idx` ON `UserOrganizationLocation` (`locationId`);--> statement-breakpoint
ALTER TABLE `JobPosting` ADD `locationId` text REFERENCES OrganizationLocation(id);--> statement-breakpoint
ALTER TABLE `JobPosting` ADD `locationIds` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `JobPosting_locationId_idx` ON `JobPosting` (`locationId`);--> statement-breakpoint
ALTER TABLE `UserOrganization` ADD `locationScope` text DEFAULT 'all' NOT NULL;
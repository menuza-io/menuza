CREATE TABLE `OrganizationSalesGoal` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`locationId` text NOT NULL,
	`month` text NOT NULL,
	`goalMinor` integer NOT NULL,
	`currency` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`locationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationSalesGoal_org_location_month_key` ON `OrganizationSalesGoal` (`organizationId`,`locationId`,`month`);--> statement-breakpoint
CREATE INDEX `OrganizationSalesGoal_organizationId_month_idx` ON `OrganizationSalesGoal` (`organizationId`,`month`);
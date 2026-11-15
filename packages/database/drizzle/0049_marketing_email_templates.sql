CREATE TABLE `MarketingEmailTemplate` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`blocks` text NOT NULL,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `MarketingEmailTemplate_organizationId_name_key` ON `MarketingEmailTemplate` (`organizationId`,`name`);
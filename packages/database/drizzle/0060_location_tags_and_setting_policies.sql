CREATE TABLE `OrganizationLocationSettingPolicy` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`settingId` text NOT NULL,
	`defaultValue` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`lockReason` text,
	`updatedById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationLocationSettingPolicy_organizationId_settingId_key` ON `OrganizationLocationSettingPolicy` (`organizationId`,`settingId`);--> statement-breakpoint
CREATE TABLE `OrganizationLocationTag` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`nameKey` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationLocationTag_organizationId_nameKey_key` ON `OrganizationLocationTag` (`organizationId`,`nameKey`);--> statement-breakpoint
CREATE TABLE `OrganizationLocationTagLink` (
	`locationId` text NOT NULL,
	`tagId` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`locationId`, `tagId`),
	FOREIGN KEY (`locationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`tagId`) REFERENCES `OrganizationLocationTag`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationLocationTagLink_tagId_idx` ON `OrganizationLocationTagLink` (`tagId`);--> statement-breakpoint
CREATE TABLE `UserOrganizationLocationTag` (
	`userId` text NOT NULL,
	`organizationId` text NOT NULL,
	`tagId` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`userId`, `organizationId`, `tagId`),
	FOREIGN KEY (`tagId`) REFERENCES `OrganizationLocationTag`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`,`organizationId`) REFERENCES `UserOrganization`(`userId`,`organizationId`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `UserOrganizationLocationTag_tagId_idx` ON `UserOrganizationLocationTag` (`tagId`);
CREATE TABLE `OrganizationMenuChannelState` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`menuId` text NOT NULL,
	`integrationId` text NOT NULL,
	`selected` integer,
	`lastStatus` text,
	`lastError` text,
	`pushedCount` integer,
	`lastSyncAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`menuId`) REFERENCES `OrganizationMenu`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`integrationId`) REFERENCES `Integration`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuChannelState_organizationId_idx` ON `OrganizationMenuChannelState` (`organizationId`);--> statement-breakpoint
CREATE INDEX `OrganizationMenuChannelState_integrationId_idx` ON `OrganizationMenuChannelState` (`integrationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuChannelState_menu_integration_key` ON `OrganizationMenuChannelState` (`menuId`,`integrationId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuPublish` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`menuId` text NOT NULL,
	`revision` integer NOT NULL,
	`actorId` text,
	`status` text NOT NULL,
	`targets` text DEFAULT '[]' NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`menuId`) REFERENCES `OrganizationMenu`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuPublish_organizationId_idx` ON `OrganizationMenuPublish` (`organizationId`);--> statement-breakpoint
CREATE INDEX `OrganizationMenuPublish_menuId_idx` ON `OrganizationMenuPublish` (`menuId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuPublished` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`menuId` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`content` text NOT NULL,
	`publishedAt` integer NOT NULL,
	`publishedByUserId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`menuId`) REFERENCES `OrganizationMenu`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`publishedByUserId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuPublished_organizationId_idx` ON `OrganizationMenuPublished` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuPublished_menuId_key` ON `OrganizationMenuPublished` (`menuId`);--> statement-breakpoint
ALTER TABLE `OrganizationMenu` ADD `hasUnpublishedChanges` integer DEFAULT false NOT NULL;
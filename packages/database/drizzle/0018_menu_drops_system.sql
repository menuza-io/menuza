CREATE TABLE `OrganizationDrop` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`menuId` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`coverImageKey` text,
	`coverImageUrl` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`ordersOpenAt` integer,
	`ordersCloseAt` integer,
	`visibility` text DEFAULT 'public' NOT NULL,
	`checkoutHoldMinutes` integer DEFAULT 5 NOT NULL,
	`showOrdersOpenTime` integer DEFAULT true NOT NULL,
	`showMenuPreview` integer DEFAULT true NOT NULL,
	`showInventoryRemaining` integer DEFAULT true NOT NULL,
	`includeGiftCard` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`menuId`) REFERENCES `OrganizationMenu`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationDrop_organizationId_idx` ON `OrganizationDrop` (`organizationId`);
--> statement-breakpoint
CREATE INDEX `OrganizationDrop_menuId_idx` ON `OrganizationDrop` (`menuId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationDrop_organizationId_slug_key` ON `OrganizationDrop` (`organizationId`,`slug`);
--> statement-breakpoint
CREATE TABLE `OrganizationDropPickupWindow` (
	`id` text PRIMARY KEY NOT NULL,
	`dropId` text NOT NULL,
	`locationId` text NOT NULL,
	`date` text NOT NULL,
	`startTime` text NOT NULL,
	`endTime` text NOT NULL,
	`slotIntervalMinutes` integer DEFAULT 30 NOT NULL,
	`maxOrdersPerSlot` integer,
	`orderLeadTimeMinutes` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`dropId`) REFERENCES `OrganizationDrop`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`locationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationDropPickupWindow_dropId_idx` ON `OrganizationDropPickupWindow` (`dropId`);
--> statement-breakpoint
CREATE INDEX `OrganizationDropPickupWindow_locationId_idx` ON `OrganizationDropPickupWindow` (`locationId`);
--> statement-breakpoint
CREATE TABLE `OrganizationDropInventory` (
	`id` text PRIMARY KEY NOT NULL,
	`dropId` text NOT NULL,
	`entityType` text NOT NULL,
	`entityId` text NOT NULL,
	`inventory` integer,
	`maxPerOrder` integer,
	`maxPerPickupSlot` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`dropId`) REFERENCES `OrganizationDrop`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationDropInventory_dropId_idx` ON `OrganizationDropInventory` (`dropId`);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationDropInventory_drop_entity_key` ON `OrganizationDropInventory` (`dropId`,`entityType`,`entityId`);
--> statement-breakpoint
CREATE TABLE `OrganizationDropReminder` (
	`id` text PRIMARY KEY NOT NULL,
	`dropId` text NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`triggerType` text NOT NULL,
	`scheduledAt` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sentAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`dropId`) REFERENCES `OrganizationDrop`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationDropReminder_dropId_idx` ON `OrganizationDropReminder` (`dropId`);

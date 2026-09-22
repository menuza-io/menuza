CREATE TABLE `OrganizationLocation` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`phone` text,
	`timezone` text DEFAULT 'America/New_York' NOT NULL,
	`taxRate` real DEFAULT 0 NOT NULL,
	`address` text,
	`storeHours` text,
	`onlineHours` text,
	`specialHours` text,
	`prepTime` integer DEFAULT 15 NOT NULL,
	`largeOrderThreshold` real DEFAULT 100,
	`largeOrderThresholdType` text DEFAULT 'dollars' NOT NULL,
	`largeOrderExtraPrepTime` integer DEFAULT 15 NOT NULL,
	`fulfillmentOptions` text,
	`inHouseTips` text,
	`scheduling` text,
	`deliveryConfig` text,
	`deliveryZones` text,
	`isActive` integer DEFAULT true NOT NULL,
	`isDefault` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationLocation_organizationId_idx` ON `OrganizationLocation` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationLocation_organizationId_slug_key` ON `OrganizationLocation` (`organizationId`,`slug`);--> statement-breakpoint
CREATE TABLE `OrganizationMenu` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`displayName` text NOT NULL,
	`internalName` text,
	`menuType` text DEFAULT 'online_pos_kiosk' NOT NULL,
	`nutritionalInfo` integer DEFAULT true NOT NULL,
	`specialInstructions` integer DEFAULT true NOT NULL,
	`availabilityHours` text,
	`availabilityStatus` text DEFAULT 'available' NOT NULL,
	`unavailableUntil` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenu_organizationId_idx` ON `OrganizationMenu` (`organizationId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuCategory` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`displayName` text NOT NULL,
	`internalName` text,
	`description` text,
	`upsellCategoryIds` text DEFAULT '[]' NOT NULL,
	`availabilityHours` text,
	`availabilityStatus` text DEFAULT 'available' NOT NULL,
	`unavailableUntil` integer,
	`excludeFromOverride` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuCategory_organizationId_idx` ON `OrganizationMenuCategory` (`organizationId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuCategoryAssignment` (
	`id` text PRIMARY KEY NOT NULL,
	`menuId` text NOT NULL,
	`categoryId` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`menuId`) REFERENCES `OrganizationMenu`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`categoryId`) REFERENCES `OrganizationMenuCategory`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuCategoryAssignment_menuId_idx` ON `OrganizationMenuCategoryAssignment` (`menuId`);--> statement-breakpoint
CREATE INDEX `OrganizationMenuCategoryAssignment_categoryId_idx` ON `OrganizationMenuCategoryAssignment` (`categoryId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuCategoryAssignment_menu_category_key` ON `OrganizationMenuCategoryAssignment` (`menuId`,`categoryId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuItem` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`displayName` text NOT NULL,
	`internalName` text,
	`description` text,
	`price` real DEFAULT 0 NOT NULL,
	`imageKey` text,
	`imageUrl` text,
	`imageKeys` text DEFAULT '[]' NOT NULL,
	`isAlcohol` integer DEFAULT false NOT NULL,
	`isGlutenFree` integer DEFAULT false NOT NULL,
	`isVegetarian` integer DEFAULT false NOT NULL,
	`allergens` text DEFAULT '[]' NOT NULL,
	`calorieMin` integer,
	`calorieMax` integer,
	`applySalesTax` integer DEFAULT true NOT NULL,
	`excludeFromOverride` integer DEFAULT false NOT NULL,
	`isPopular` integer DEFAULT false NOT NULL,
	`isUpsell` integer DEFAULT false NOT NULL,
	`availabilityStatus` text DEFAULT 'available' NOT NULL,
	`unavailableUntil` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuItem_organizationId_idx` ON `OrganizationMenuItem` (`organizationId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuItemCategoryAssignment` (
	`id` text PRIMARY KEY NOT NULL,
	`categoryId` text NOT NULL,
	`itemId` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`categoryId`) REFERENCES `OrganizationMenuCategory`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`itemId`) REFERENCES `OrganizationMenuItem`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuItemCategoryAssignment_categoryId_idx` ON `OrganizationMenuItemCategoryAssignment` (`categoryId`);--> statement-breakpoint
CREATE INDEX `OrganizationMenuItemCategoryAssignment_itemId_idx` ON `OrganizationMenuItemCategoryAssignment` (`itemId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuItemCategoryAssignment_cat_item_key` ON `OrganizationMenuItemCategoryAssignment` (`categoryId`,`itemId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuItemModifierGroupAssignment` (
	`id` text PRIMARY KEY NOT NULL,
	`itemId` text NOT NULL,
	`modifierGroupId` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`itemId`) REFERENCES `OrganizationMenuItem`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`modifierGroupId`) REFERENCES `OrganizationMenuModifierGroup`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuItemModifierGroupAssignment_itemId_idx` ON `OrganizationMenuItemModifierGroupAssignment` (`itemId`);--> statement-breakpoint
CREATE INDEX `OrganizationMenuItemModifierGroupAssignment_modifierGroupId_idx` ON `OrganizationMenuItemModifierGroupAssignment` (`modifierGroupId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuItemModifierGroupAssignment_item_group_key` ON `OrganizationMenuItemModifierGroupAssignment` (`itemId`,`modifierGroupId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuLocationOverride` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`locationId` text NOT NULL,
	`entityType` text NOT NULL,
	`entityId` text NOT NULL,
	`isEnabled` integer,
	`price` real,
	`availabilityStatus` text,
	`unavailableUntil` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`locationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuLocationOverride_locationId_idx` ON `OrganizationMenuLocationOverride` (`locationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuLocationOverride_loc_entity_key` ON `OrganizationMenuLocationOverride` (`locationId`,`entityType`,`entityId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuModifierGroup` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`internalName` text,
	`selectionType` text DEFAULT 'single' NOT NULL,
	`minSelections` integer DEFAULT 0 NOT NULL,
	`maxSelections` integer,
	`availabilityStatus` text DEFAULT 'available' NOT NULL,
	`unavailableUntil` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuModifierGroup_organizationId_idx` ON `OrganizationMenuModifierGroup` (`organizationId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuModifierGroupOptionAssignment` (
	`id` text PRIMARY KEY NOT NULL,
	`modifierGroupId` text NOT NULL,
	`optionId` text NOT NULL,
	`priceOverride` real,
	`priceWholeOverride` real,
	`priceLeftOverride` real,
	`priceRightOverride` real,
	`isDefault` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`modifierGroupId`) REFERENCES `OrganizationMenuModifierGroup`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`optionId`) REFERENCES `OrganizationMenuOption`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuModifierGroupOptionAssignment_modifierGroupId_idx` ON `OrganizationMenuModifierGroupOptionAssignment` (`modifierGroupId`);--> statement-breakpoint
CREATE INDEX `OrganizationMenuModifierGroupOptionAssignment_optionId_idx` ON `OrganizationMenuModifierGroupOptionAssignment` (`optionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationMenuModifierGroupOptionAssignment_group_option_key` ON `OrganizationMenuModifierGroupOptionAssignment` (`modifierGroupId`,`optionId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuModifierOption` (
	`id` text PRIMARY KEY NOT NULL,
	`modifierGroupId` text NOT NULL,
	`displayName` text NOT NULL,
	`internalName` text,
	`description` text,
	`imageKey` text,
	`price` real DEFAULT 0 NOT NULL,
	`priceWhole` real,
	`priceLeft` real,
	`priceRight` real,
	`minSelections` integer DEFAULT 0 NOT NULL,
	`maxSelections` integer,
	`isAlcohol` integer DEFAULT false NOT NULL,
	`isGlutenFree` integer DEFAULT false NOT NULL,
	`isVegetarian` integer DEFAULT false NOT NULL,
	`isTopping` integer DEFAULT false NOT NULL,
	`allergens` text DEFAULT '[]' NOT NULL,
	`applySalesTax` integer DEFAULT true NOT NULL,
	`availabilityStatus` text DEFAULT 'available' NOT NULL,
	`unavailableUntil` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`modifierGroupId`) REFERENCES `OrganizationMenuModifierGroup`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuModifierOption_modifierGroupId_idx` ON `OrganizationMenuModifierOption` (`modifierGroupId`);--> statement-breakpoint
CREATE TABLE `OrganizationMenuOption` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`displayName` text NOT NULL,
	`internalName` text,
	`description` text,
	`imageKey` text,
	`price` real DEFAULT 0 NOT NULL,
	`priceWhole` real,
	`priceLeft` real,
	`priceRight` real,
	`calories` integer,
	`minSelections` integer DEFAULT 0 NOT NULL,
	`maxSelections` integer,
	`isAlcohol` integer DEFAULT false NOT NULL,
	`isGlutenFree` integer DEFAULT false NOT NULL,
	`isVegetarian` integer DEFAULT false NOT NULL,
	`isTopping` integer DEFAULT false NOT NULL,
	`allergens` text DEFAULT '[]' NOT NULL,
	`applySalesTax` integer DEFAULT true NOT NULL,
	`availabilityStatus` text DEFAULT 'available' NOT NULL,
	`unavailableUntil` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuOption_organizationId_idx` ON `OrganizationMenuOption` (`organizationId`);
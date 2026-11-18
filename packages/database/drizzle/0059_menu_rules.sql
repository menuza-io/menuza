CREATE TABLE `OrganizationMenuPricingRule` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`percentBp` integer NOT NULL,
	`menuIds` text DEFAULT '[]' NOT NULL,
	`categoryIds` text DEFAULT '[]' NOT NULL,
	`locationIds` text DEFAULT '[]' NOT NULL,
	`roundingMode` text DEFAULT 'none' NOT NULL,
	`roundingValue` integer DEFAULT 0 NOT NULL,
	`excludeMinPrice` real,
	`excludeMaxPrice` real,
	`startsAt` integer,
	`endedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationMenuPricingRule_organizationId_idx` ON `OrganizationMenuPricingRule` (`organizationId`);--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `dietaryTags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `orderTypePrices` text;--> statement-breakpoint
ALTER TABLE `OrganizationMenuOption` ADD `dietaryTags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMenuOption` ADD `orderTypePrices` text;--> statement-breakpoint
UPDATE `OrganizationMenuItem` SET `dietaryTags` = CASE
	WHEN `isVegetarian` = 1 AND `isGlutenFree` = 1 THEN '["vegetarian","gluten_free"]'
	WHEN `isVegetarian` = 1 THEN '["vegetarian"]'
	WHEN `isGlutenFree` = 1 THEN '["gluten_free"]'
	ELSE '[]'
END;--> statement-breakpoint
UPDATE `OrganizationMenuOption` SET `dietaryTags` = CASE
	WHEN `isVegetarian` = 1 AND `isGlutenFree` = 1 THEN '["vegetarian","gluten_free"]'
	WHEN `isVegetarian` = 1 THEN '["vegetarian"]'
	WHEN `isGlutenFree` = 1 THEN '["gluten_free"]'
	ELSE '[]'
END;

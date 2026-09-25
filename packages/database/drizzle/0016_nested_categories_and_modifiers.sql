CREATE TABLE `OrganizationMenuOptionNestedModifierGroupAssignment` (
	`id` text PRIMARY KEY NOT NULL,
	`optionId` text NOT NULL,
	`modifierGroupId` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`optionId`) REFERENCES `OrganizationMenuOption`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`modifierGroupId`) REFERENCES `OrganizationMenuModifierGroup`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrgMenuOptNestedModGrpAsgn_optId_idx` ON `OrganizationMenuOptionNestedModifierGroupAssignment` (`optionId`);--> statement-breakpoint
CREATE INDEX `OrgMenuOptNestedModGrpAsgn_groupId_idx` ON `OrganizationMenuOptionNestedModifierGroupAssignment` (`modifierGroupId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrgMenuOptNestedModGrpAsgn_opt_group_key` ON `OrganizationMenuOptionNestedModifierGroupAssignment` (`optionId`,`modifierGroupId`);--> statement-breakpoint
ALTER TABLE `OrganizationMenuCategory` ADD `parentId` text REFERENCES OrganizationMenuCategory(id);--> statement-breakpoint
CREATE INDEX `OrganizationMenuCategory_parentId_idx` ON `OrganizationMenuCategory` (`parentId`);--> statement-breakpoint
ALTER TABLE `OrganizationMenuOption` ADD `nestedModifierGroupIds` text DEFAULT '[]' NOT NULL;
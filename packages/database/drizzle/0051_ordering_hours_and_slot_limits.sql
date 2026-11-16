-- Online ordering hours buffers (#330), slot limits (#108, #256), prep schedule (#229),
-- prayer pauses (#342). Policy lives on OrganizationLocation; enforcement is regional.
ALTER TABLE `OrganizationLocation` ADD `onlineOrderingSettings` text;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `slotLimitSettings` text;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `prepSchedule` text;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `prayerPauseSettings` text;--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `excludeFromOrderLimits` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMenuCategory` ADD `excludeFromOrderLimits` integer DEFAULT false NOT NULL;
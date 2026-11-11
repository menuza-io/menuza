ALTER TABLE `OrganizationLocation` ADD `orderingPausedAt` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `orderingPausedUntil` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `busyExtraPrepMinutes` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `busyUntil` integer;
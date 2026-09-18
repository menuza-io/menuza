CREATE TABLE IF NOT EXISTS `OrganizationLocation` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`addressLine1` text,
	`addressLine2` text,
	`city` text,
	`state` text,
	`postalCode` text,
	`country` text DEFAULT 'US',
	`timezone` text DEFAULT 'America/Chicago' NOT NULL,
	`hoursJson` text,
	`isDefault` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `OrganizationLocation_organizationId_idx` ON `OrganizationLocation` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `OrganizationLocation_organizationId_slug_key` ON `OrganizationLocation` (`organizationId`,`slug`);

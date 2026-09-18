CREATE TABLE IF NOT EXISTS `OrganizationLocation` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`active` integer DEFAULT true NOT NULL,
	`isDefault` integer DEFAULT false NOT NULL,
	`addressLine1` text,
	`addressLine2` text,
	`city` text,
	`state` text,
	`postalCode` text,
	`country` text DEFAULT 'US',
	`formattedAddress` text,
	`latitude` real,
	`longitude` real,
	`googlePlaceId` text,
	`phone` text,
	`email` text,
	`timezone` text DEFAULT 'America/Chicago' NOT NULL,
	`storeHoursJson` text,
	`onlineHoursJson` text,
	`specialHoursJson` text,
	`storeHoursOverride` integer DEFAULT false NOT NULL,
	`onlineHoursOverride` integer DEFAULT false NOT NULL,
	`hoursJson` text,
	`prepTimeMinutes` integer DEFAULT 15 NOT NULL,
	`busyDelayMinutes` integer DEFAULT 0 NOT NULL,
	`acceptWindowSeconds` integer DEFAULT 0 NOT NULL,
	`pickupEnabled` integer DEFAULT true NOT NULL,
	`deliveryEnabled` integer DEFAULT true NOT NULL,
	`scheduledOrdersEnabled` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `OrganizationLocation_organizationId_idx` ON `OrganizationLocation` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `OrganizationLocation_organizationId_slug_key` ON `OrganizationLocation` (`organizationId`,`slug`);--> statement-breakpoint
ALTER TABLE `Organization` ADD COLUMN `brandStoreHoursJson` text;--> statement-breakpoint
ALTER TABLE `Organization` ADD COLUMN `brandOnlineHoursJson` text;

CREATE TABLE `MarketingOccasionChoice` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`occasionKey` text NOT NULL,
	`autoSchedule` integer DEFAULT false NOT NULL,
	`channel` text DEFAULT 'email' NOT NULL,
	`audienceId` text,
	`dismissedYear` integer,
	`scheduledYear` integer,
	`campaignId` text,
	`skipReason` text,
	`skippedYear` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `MarketingOccasionChoice_organizationId_occasionKey_key` ON `MarketingOccasionChoice` (`organizationId`,`occasionKey`);--> statement-breakpoint
CREATE TABLE `MarketingSmsSend` (
	`campaignId` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`periodKey` text NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `MarketingSmsSend_organizationId_periodKey_idx` ON `MarketingSmsSend` (`organizationId`,`periodKey`);--> statement-breakpoint
CREATE TABLE `MarketingSmsUsage` (
	`organizationId` text NOT NULL,
	`periodKey` text NOT NULL,
	`sends` integer DEFAULT 0 NOT NULL,
	`extraSends` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`organizationId`, `periodKey`),
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `Organization` ADD `marketingMarket` text;
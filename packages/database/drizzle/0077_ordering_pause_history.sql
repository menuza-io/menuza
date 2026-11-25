CREATE TABLE `LocationOrderingPause` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`locationId` text NOT NULL,
	`kind` text DEFAULT 'pause' NOT NULL,
	`startedAt` integer NOT NULL,
	`plannedUntil` integer,
	`endedAt` integer,
	`endedBy` text,
	`startedBy` text,
	`source` text DEFAULT 'app' NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`locationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `LocationOrderingPause_org_location_started_idx` ON `LocationOrderingPause` (`organizationId`,`locationId`,`startedAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `LocationOrderingPause_open_pause_key` ON `LocationOrderingPause` (`locationId`) WHERE "LocationOrderingPause"."endedAt" is null and "LocationOrderingPause"."kind" = 'pause';
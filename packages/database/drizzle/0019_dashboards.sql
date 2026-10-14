CREATE TABLE `Dashboard` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`ownerId` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`ownerId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `Dashboard_organizationId_ownerId_idx` ON `Dashboard` (`organizationId`,`ownerId`);--> statement-breakpoint
CREATE UNIQUE INDEX `Dashboard_organizationId_ownerId_home_key` ON `Dashboard` (`organizationId`,`ownerId`) WHERE "Dashboard"."kind" = 'home';--> statement-breakpoint
CREATE TABLE `DashboardShare` (
	`dashboardId` text NOT NULL,
	`userId` text NOT NULL,
	`access` text NOT NULL,
	`sharedById` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	PRIMARY KEY(`dashboardId`, `userId`),
	FOREIGN KEY (`dashboardId`) REFERENCES `Dashboard`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`sharedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `DashboardShare_userId_idx` ON `DashboardShare` (`userId`);
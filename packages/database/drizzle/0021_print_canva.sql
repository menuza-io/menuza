CREATE TABLE `PrintCanvaConnection` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`canvaUserId` text,
	`displayName` text,
	`accessToken` text NOT NULL,
	`refreshToken` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`scope` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `PrintCanvaConnection_organizationId_userId_key` ON `PrintCanvaConnection` (`organizationId`,`userId`);--> statement-breakpoint
ALTER TABLE `PrintDesign` ADD `source` text DEFAULT 'template' NOT NULL;--> statement-breakpoint
ALTER TABLE `PrintDesign` ADD `artwork` text;
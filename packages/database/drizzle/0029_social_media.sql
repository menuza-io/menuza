CREATE TABLE `SocialAccount` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`platform` text NOT NULL,
	`externalId` text NOT NULL,
	`name` text NOT NULL,
	`username` text,
	`accessToken` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`connectedById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`connectedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `SocialAccount_organizationId_platform_externalId_key` ON `SocialAccount` (`organizationId`,`platform`,`externalId`);--> statement-breakpoint
CREATE TABLE `SocialPost` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`createdById` text,
	`body` text DEFAULT '' NOT NULL,
	`media` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduledAt` integer,
	`publishedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `SocialPost_organizationId_scheduledAt_idx` ON `SocialPost` (`organizationId`,`scheduledAt`);--> statement-breakpoint
CREATE INDEX `SocialPost_status_scheduledAt_idx` ON `SocialPost` (`status`,`scheduledAt`);--> statement-breakpoint
CREATE TABLE `SocialPostTarget` (
	`id` text PRIMARY KEY NOT NULL,
	`postId` text NOT NULL,
	`socialAccountId` text,
	`platform` text NOT NULL,
	`accountName` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`externalPostId` text,
	`permalink` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`publishedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`postId`) REFERENCES `SocialPost`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`socialAccountId`) REFERENCES `SocialAccount`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `SocialPostTarget_postId_idx` ON `SocialPostTarget` (`postId`);--> statement-breakpoint
CREATE INDEX `SocialPostTarget_socialAccountId_idx` ON `SocialPostTarget` (`socialAccountId`);
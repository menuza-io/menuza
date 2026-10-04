CREATE TABLE `OrganizationChatChannel` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`access` text DEFAULT 'everyone' NOT NULL,
	`kind` text DEFAULT 'channel' NOT NULL,
	`dmPairKey` text,
	`showHistoryToNewMembers` integer DEFAULT false NOT NULL,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `OrganizationChatChannel_organizationId_idx` ON `OrganizationChatChannel` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationChatChannel_organizationId_name_key` ON `OrganizationChatChannel` (`organizationId`,lower("name")) WHERE "OrganizationChatChannel"."kind" = 'channel';--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationChatChannel_organizationId_dmPairKey_key` ON `OrganizationChatChannel` (`organizationId`,`dmPairKey`);--> statement-breakpoint
CREATE TABLE `OrganizationChatChannelMember` (
	`channelId` text NOT NULL,
	`userId` text NOT NULL,
	`joinedAt` integer NOT NULL,
	PRIMARY KEY(`channelId`, `userId`),
	FOREIGN KEY (`channelId`) REFERENCES `OrganizationChatChannel`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationChatChannelMember_userId_idx` ON `OrganizationChatChannelMember` (`userId`);--> statement-breakpoint
CREATE TABLE `OrganizationChatChannelRole` (
	`channelId` text NOT NULL,
	`organizationRoleId` text NOT NULL,
	PRIMARY KEY(`channelId`, `organizationRoleId`),
	FOREIGN KEY (`channelId`) REFERENCES `OrganizationChatChannel`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationRoleId`) REFERENCES `OrganizationRole`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationChatChannelRole_organizationRoleId_idx` ON `OrganizationChatChannelRole` (`organizationRoleId`);--> statement-breakpoint
ALTER TABLE `Organization` ADD `chatRetentionDays` integer;--> statement-breakpoint
-- Managing team chat channels (create, rename, delete, and choose which roles
-- or members can access them) is its own organization permission. Reading and
-- posting only requires access to a channel, not a permission.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_update_chat_any', 'update', 'chat', 'any', 'organization', 'Create and manage team chat channels and their access', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_update_chat_any');--> statement-breakpoint
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_create_chat_group', 'create', 'chat', 'group', 'organization', 'Create group chats and add members', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_create_chat_group');

CREATE TABLE `AlertLog` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text,
	`recipientId` text,
	`locationId` text,
	`kind` text NOT NULL,
	`entityId` text NOT NULL,
	`notificationId` text,
	`outcome` text NOT NULL,
	`critical` integer DEFAULT false NOT NULL,
	`channels` text DEFAULT '[]' NOT NULL,
	`heldChannels` text,
	`heldUntil` integer,
	`releasedAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `AlertLog_organizationId_createdAt_idx` ON `AlertLog` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `AlertLog_userId_kind_createdAt_idx` ON `AlertLog` (`userId`,`kind`,`createdAt`);--> statement-breakpoint
CREATE INDEX `AlertLog_outcome_heldUntil_idx` ON `AlertLog` (`outcome`,`heldUntil`);--> statement-breakpoint
CREATE UNIQUE INDEX `AlertLog_member_entity_key` ON `AlertLog` (`organizationId`,`userId`,`kind`,`entityId`) WHERE "AlertLog"."userId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `AlertLog_recipient_entity_key` ON `AlertLog` (`organizationId`,`recipientId`,`kind`,`entityId`) WHERE "AlertLog"."recipientId" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `OperatorPushDelivery` (
	`id` text PRIMARY KEY NOT NULL,
	`notificationId` text NOT NULL,
	`deviceId` text NOT NULL,
	`ticketId` text,
	`status` text DEFAULT 'claimed' NOT NULL,
	`createdAt` integer NOT NULL,
	`checkedAt` integer,
	FOREIGN KEY (`deviceId`) REFERENCES `OperatorPushDevice`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OperatorPushDelivery_notificationId_deviceId_key` ON `OperatorPushDelivery` (`notificationId`,`deviceId`);--> statement-breakpoint
CREATE INDEX `OperatorPushDelivery_status_createdAt_idx` ON `OperatorPushDelivery` (`status`,`createdAt`);--> statement-breakpoint
CREATE TABLE `OperatorPushDevice` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`token` text NOT NULL,
	`platform` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`deviceName` text,
	`appVersion` text,
	`createdAt` integer NOT NULL,
	`lastSeenAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OperatorPushDevice_token_key` ON `OperatorPushDevice` (`token`);--> statement-breakpoint
CREATE INDEX `OperatorPushDevice_userId_idx` ON `OperatorPushDevice` (`userId`);--> statement-breakpoint
CREATE TABLE `OrderAlertRecipient` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`locationId` text NOT NULL,
	`kind` text NOT NULL,
	`address` text NOT NULL,
	`phoneHash` text,
	`verifiedAt` integer,
	`stoppedAt` integer,
	`verifyCodeHash` text,
	`verifyExpiresAt` integer,
	`verifyAttempts` integer DEFAULT 0 NOT NULL,
	`verifySentAt` integer,
	`verifySentCount` integer DEFAULT 0 NOT NULL,
	`onlineOrders` integer DEFAULT true NOT NULL,
	`scheduledOrders` integer DEFAULT true NOT NULL,
	`createdBy` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`locationId`) REFERENCES `OrganizationLocation`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrderAlertRecipient_location_address_key` ON `OrderAlertRecipient` (`locationId`,`address`);--> statement-breakpoint
CREATE INDEX `OrderAlertRecipient_organizationId_idx` ON `OrderAlertRecipient` (`organizationId`);--> statement-breakpoint
CREATE INDEX `OrderAlertRecipient_phoneHash_idx` ON `OrderAlertRecipient` (`phoneHash`);--> statement-breakpoint
ALTER TABLE `NotificationPreference` ADD `push` integer;--> statement-breakpoint
ALTER TABLE `NotificationPreference` ADD `threshold` integer;--> statement-breakpoint
ALTER TABLE `NotificationPreference` ADD `quietStart` text;--> statement-breakpoint
ALTER TABLE `NotificationPreference` ADD `quietEnd` text;--> statement-breakpoint
ALTER TABLE `NotificationPreference` ADD `timeZone` text;--> statement-breakpoint
ALTER TABLE `NotificationPreference` ADD `snoozedUntil` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `busyStartedAt` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `orderAlertMinutes` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `largeOrderAlert` text;--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'notifications.operator_push', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'notifications.operator_push' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'orders.manager_alerts', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'orders.manager_alerts' AND "level" = 'system');

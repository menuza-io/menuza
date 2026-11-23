CREATE TABLE `FeedbackMessage` (
	`id` text PRIMARY KEY NOT NULL,
	`feedbackId` text NOT NULL,
	`side` text NOT NULL,
	`authorId` text,
	`body` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`feedbackId`) REFERENCES `Feedback`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `FeedbackMessage_feedbackId_createdAt_idx` ON `FeedbackMessage` (`feedbackId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `OrganizationAssignment` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`adminUserId` text NOT NULL,
	`role` text NOT NULL,
	`locationId` text,
	`scopeKey` text DEFAULT 'all' NOT NULL,
	`startedAt` integer NOT NULL,
	`endedAt` integer,
	`assignedById` text,
	`endedById` text,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`adminUserId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`assignedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`endedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationAssignment_open_key` ON `OrganizationAssignment` (`organizationId`,`role`,`scopeKey`) WHERE "OrganizationAssignment"."endedAt" IS NULL;--> statement-breakpoint
CREATE INDEX `OrganizationAssignment_adminUserId_endedAt_idx` ON `OrganizationAssignment` (`adminUserId`,`endedAt`);--> statement-breakpoint
CREATE INDEX `OrganizationAssignment_organizationId_startedAt_idx` ON `OrganizationAssignment` (`organizationId`,`startedAt`);--> statement-breakpoint
CREATE TABLE `OrganizationEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`locationId` text,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`dedupeKey` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `OrganizationEvent_organizationId_createdAt_idx` ON `OrganizationEvent` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `OrganizationEvent_organizationId_kind_createdAt_idx` ON `OrganizationEvent` (`organizationId`,`kind`,`createdAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationEvent_organizationId_dedupeKey_key` ON `OrganizationEvent` (`organizationId`,`dedupeKey`) WHERE "OrganizationEvent"."dedupeKey" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `SignInCodeDelivery` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text,
	`organizationId` text,
	`purpose` text NOT NULL,
	`channel` text NOT NULL,
	`destinationHash` text NOT NULL,
	`destinationHint` text NOT NULL,
	`provider` text NOT NULL,
	`providerMessageId` text,
	`status` text DEFAULT 'sent' NOT NULL,
	`failureReason` text,
	`lineType` text,
	`carrier` text,
	`numberValid` integer,
	`lookedUpAt` integer,
	`createdAt` integer NOT NULL,
	`statusAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `SignInCodeDelivery_userId_createdAt_idx` ON `SignInCodeDelivery` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `SignInCodeDelivery_destinationHash_createdAt_idx` ON `SignInCodeDelivery` (`destinationHash`,`createdAt`);--> statement-breakpoint
CREATE INDEX `SignInCodeDelivery_expiresAt_idx` ON `SignInCodeDelivery` (`expiresAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `SignInCodeDelivery_provider_message_key` ON `SignInCodeDelivery` (`provider`,`providerMessageId`) WHERE "SignInCodeDelivery"."providerMessageId" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `SupportNote` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`authorId` text,
	`body` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`authorId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `SupportNote_organizationId_pinned_createdAt_idx` ON `SupportNote` (`organizationId`,`pinned`,`createdAt`);--> statement-breakpoint
CREATE TABLE `SupportVerification` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`agentId` text NOT NULL,
	`codeHash` text,
	`expiresAt` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lockedUntil` integer,
	`verifiedAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`agentId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `SupportVerification_userId_createdAt_idx` ON `SupportVerification` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `SupportVerification_agentId_userId_verifiedAt_idx` ON `SupportVerification` (`agentId`,`userId`,`verifiedAt`);--> statement-breakpoint
ALTER TABLE `Feedback` ADD `kind` text DEFAULT 'feedback' NOT NULL;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `status` text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `subject` text;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `context` text;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `errorId` text;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `screenshotKey` text;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `assigneeId` text REFERENCES User(id);--> statement-breakpoint
ALTER TABLE `Feedback` ADD `lastMessageAt` integer;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `lastMessageSide` text;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `memberReadAt` integer;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `supportReadAt` integer;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `closedAt` integer;--> statement-breakpoint
ALTER TABLE `Feedback` ADD `closedById` text REFERENCES User(id);--> statement-breakpoint
CREATE INDEX `Feedback_organizationId_kind_status_idx` ON `Feedback` (`organizationId`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `Feedback_assigneeId_status_idx` ON `Feedback` (`assigneeId`,`status`);--> statement-breakpoint
CREATE INDEX `Feedback_kind_status_lastMessageAt_idx` ON `Feedback` (`kind`,`status`,`lastMessageAt`);
CREATE TABLE `SetupReminder` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`kind` text NOT NULL,
	`day` integer,
	`stepKey` text NOT NULL,
	`doneCount` integer NOT NULL,
	`totalCount` integer NOT NULL,
	`recipientCount` integer NOT NULL,
	`sentById` text,
	`sentAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`sentById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `SetupReminder_organizationId_sentAt_idx` ON `SetupReminder` (`organizationId`,`sentAt`);--> statement-breakpoint
CREATE TABLE `SetupReminderState` (
	`organizationId` text PRIMARY KEY NOT NULL,
	`progressSignature` text NOT NULL,
	`progressAt` integer NOT NULL,
	`lastAutoDay` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `SsoFailureEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`errorType` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `SsoFailureEvent_organizationId_createdAt_idx` ON `SsoFailureEvent` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `SsoFailureNotice` (
	`organizationId` text PRIMARY KEY NOT NULL,
	`lastNotifiedAt` integer NOT NULL,
	`lastErrorType` text NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `SubscriptionChangeRequest` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`requestedById` text,
	`kind` text NOT NULL,
	`locationIds` text,
	`targetPlan` text,
	`reason` text NOT NULL,
	`subReason` text,
	`note` text,
	`effectiveAt` integer,
	`retentionOffer` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`handledById` text,
	`handledAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`handledById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `SubscriptionChangeRequest_organizationId_createdAt_idx` ON `SubscriptionChangeRequest` (`organizationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `SubscriptionChangeRequest_status_createdAt_idx` ON `SubscriptionChangeRequest` (`status`,`createdAt`);--> statement-breakpoint
ALTER TABLE `Organization` ADD `pastDueSince` integer;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `hoursWarningsDismissedFor` text;
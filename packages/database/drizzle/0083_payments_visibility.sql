CREATE TABLE `PaymentAccountStatus` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`provider` text NOT NULL,
	`providerAccountId` text,
	`chargesEnabled` integer DEFAULT false NOT NULL,
	`payoutsEnabled` integer DEFAULT false NOT NULL,
	`requirementsDue` text DEFAULT '[]' NOT NULL,
	`deadline` integer,
	`lastNotifiedState` text,
	`lastReminderBucket` integer,
	`lastNotifiedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `PaymentAccountStatus_org_provider_key` ON `PaymentAccountStatus` (`organizationId`,`provider`);--> statement-breakpoint
CREATE INDEX `PaymentAccountStatus_deadline_idx` ON `PaymentAccountStatus` (`deadline`);--> statement-breakpoint
CREATE TABLE `PaymentDispute` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`provider` text NOT NULL,
	`providerDisputeId` text NOT NULL,
	`providerPaymentId` text,
	`orderKind` text DEFAULT 'restaurant_order' NOT NULL,
	`orderRef` text NOT NULL,
	`amountMinor` integer NOT NULL,
	`feeMinor` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`dueAt` integer,
	`submittedAt` integer,
	`closedAt` integer,
	`alreadyRefunded` integer DEFAULT false NOT NULL,
	`openedNotifiedAt` integer,
	`reminderSentAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `PaymentDispute_provider_dispute_key` ON `PaymentDispute` (`provider`,`providerDisputeId`);--> statement-breakpoint
CREATE INDEX `PaymentDispute_org_status_due_idx` ON `PaymentDispute` (`organizationId`,`status`,`dueAt`);--> statement-breakpoint
CREATE TABLE `PaymentPayoutCache` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`provider` text NOT NULL,
	`cacheKey` text NOT NULL,
	`json` text NOT NULL,
	`fetchedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `PaymentPayoutCache_org_provider_cacheKey_key` ON `PaymentPayoutCache` (`organizationId`,`provider`,`cacheKey`);--> statement-breakpoint
-- Payments visibility (#168, #423): grant read:payments:any to built-in admin role.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_payments_any', 'read', 'payments', 'any', 'organization', 'View payment payouts, balances, and card details', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_payments_any');

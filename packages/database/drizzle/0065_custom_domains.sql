CREATE TABLE `DomainCharge` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`managedDomainId` text,
	`jobId` text,
	`kind` text NOT NULL,
	`amountCents` integer NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`idempotencyKey` text NOT NULL,
	`stripePaymentIntentId` text,
	`stripeRefundId` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`failureCode` text,
	`refundedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`managedDomainId`) REFERENCES `ManagedDomain`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`jobId`) REFERENCES `DomainJob`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `DomainCharge_idempotencyKey_key` ON `DomainCharge` (`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `DomainCharge_organizationId_idx` ON `DomainCharge` (`organizationId`);--> statement-breakpoint
CREATE INDEX `DomainCharge_managedDomainId_idx` ON `DomainCharge` (`managedDomainId`);--> statement-breakpoint
CREATE TABLE `DomainEmailForward` (
	`id` text PRIMARY KEY NOT NULL,
	`managedDomainId` text NOT NULL,
	`localPart` text NOT NULL,
	`destination` text NOT NULL,
	`status` text DEFAULT 'pending_confirmation' NOT NULL,
	`providerRuleId` text,
	`lastForwardedAt` integer,
	`lastError` text,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`managedDomainId`) REFERENCES `ManagedDomain`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `DomainEmailForward_domain_localPart_key` ON `DomainEmailForward` (`managedDomainId`,`localPart`);--> statement-breakpoint
CREATE INDEX `DomainEmailForward_status_idx` ON `DomainEmailForward` (`status`);--> statement-breakpoint
CREATE TABLE `DomainJob` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`managedDomainId` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`step` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`idempotencyKey` text NOT NULL,
	`runAfter` integer NOT NULL,
	`params` text,
	`createdById` text,
	`completedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`managedDomainId`) REFERENCES `ManagedDomain`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `DomainJob_idempotencyKey_key` ON `DomainJob` (`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `DomainJob_status_runAfter_idx` ON `DomainJob` (`status`,`runAfter`);--> statement-breakpoint
CREATE INDEX `DomainJob_organizationId_idx` ON `DomainJob` (`organizationId`);--> statement-breakpoint
CREATE INDEX `DomainJob_managedDomainId_idx` ON `DomainJob` (`managedDomainId`);--> statement-breakpoint
CREATE TABLE `DomainRecord` (
	`id` text PRIMARY KEY NOT NULL,
	`managedDomainId` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`ttl` integer DEFAULT 1 NOT NULL,
	`priority` integer,
	`proxied` integer DEFAULT false NOT NULL,
	`managedBy` text,
	`source` text DEFAULT 'user' NOT NULL,
	`providerRecordId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`managedDomainId`) REFERENCES `ManagedDomain`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `DomainRecord_managedDomainId_idx` ON `DomainRecord` (`managedDomainId`);--> statement-breakpoint
CREATE TABLE `ManagedDomain` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`fqdn` text NOT NULL,
	`source` text DEFAULT 'nameservers' NOT NULL,
	`zoneProvider` text,
	`zoneId` text,
	`nameservers` text,
	`zoneStatus` text DEFAULT 'pending' NOT NULL,
	`nsPendingSince` integer,
	`nsCheckedAt` integer,
	`nsVerifiedAt` integer,
	`scan` text,
	`emailRiskConfirmedAt` integer,
	`registrar` text,
	`registrarDomainId` text,
	`registrationStatus` text DEFAULT 'none' NOT NULL,
	`expiresAt` integer,
	`autoRenew` integer DEFAULT true NOT NULL,
	`locked` integer DEFAULT true NOT NULL,
	`privacy` integer DEFAULT true NOT NULL,
	`registrantContact` text,
	`registrantEmailConfirmedAt` integer,
	`reminders` text,
	`renewalFailedSince` integer,
	`renewalAttemptedAt` integer,
	`lastJobId` text,
	`emailForwardingEnabledAt` integer,
	`emailForwardingMxConfirmedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ManagedDomain_fqdn_key` ON `ManagedDomain` (`fqdn`);--> statement-breakpoint
CREATE INDEX `ManagedDomain_organizationId_idx` ON `ManagedDomain` (`organizationId`);--> statement-breakpoint
CREATE INDEX `ManagedDomain_zoneStatus_idx` ON `ManagedDomain` (`zoneStatus`);--> statement-breakpoint
CREATE INDEX `ManagedDomain_registrationStatus_expiresAt_idx` ON `ManagedDomain` (`registrationStatus`,`expiresAt`);--> statement-breakpoint
CREATE TABLE `OrganizationEmailSender` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`senderName` text,
	`replyTo` text,
	`replyToVerifiedAt` integer,
	`pendingReplyTo` text,
	`replyToCodeHash` text,
	`replyToCodeExpiresAt` integer,
	`replyToCodeAttempts` integer DEFAULT 0 NOT NULL,
	`replyToCodeSentAt` integer,
	`localPart` text DEFAULT 'hello' NOT NULL,
	`domain` text,
	`domainStatus` text DEFAULT 'none' NOT NULL,
	`dkimSelector` text,
	`providerRef` text,
	`dnsRecords` text,
	`dataRegion` text,
	`checkedAt` integer,
	`verifiedAt` integer,
	`failedAt` integer,
	`fallbackNotifiedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationEmailSender_organizationId_key` ON `OrganizationEmailSender` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `OrganizationEmailSender_domain_key` ON `OrganizationEmailSender` (`domain`) WHERE "OrganizationEmailSender"."domain" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `OrganizationEmailSender_domainStatus_idx` ON `OrganizationEmailSender` (`domainStatus`);--> statement-breakpoint
CREATE TABLE `SiteDomain` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`hostname` text NOT NULL,
	`isPrimary` integer DEFAULT false NOT NULL,
	`managedDomainId` text,
	`method` text DEFAULT 'cname' NOT NULL,
	`cloudflareHostnameId` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`sslStatus` text,
	`ownershipStatus` text,
	`verification` text,
	`checks` text,
	`lastError` text,
	`pendingSince` integer,
	`lastCheckedAt` integer,
	`reminderSentAt` integer,
	`liveNotifiedAt` integer,
	`addedById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`managedDomainId`) REFERENCES `ManagedDomain`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`addedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `SiteDomain_hostname_key` ON `SiteDomain` (`hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `SiteDomain_primary_key` ON `SiteDomain` (`organizationId`) WHERE "SiteDomain"."isPrimary" = 1;--> statement-breakpoint
CREATE INDEX `SiteDomain_organizationId_idx` ON `SiteDomain` (`organizationId`);--> statement-breakpoint
CREATE INDEX `SiteDomain_status_pendingSince_idx` ON `SiteDomain` (`status`,`pendingSince`);--> statement-breakpoint
CREATE INDEX `SiteDomain_managedDomainId_idx` ON `SiteDomain` (`managedDomainId`);
--> statement-breakpoint
-- #139: every connected domain becomes the primary SiteDomain of its organization.
-- Organization.customDomain stays as the denormalized primary for one release, so
-- the public lookups that still read it keep working before and after this row exists.
INSERT INTO `SiteDomain` (`id`, `organizationId`, `hostname`, `isPrimary`, `method`, `cloudflareHostnameId`, `status`, `pendingSince`, `createdAt`, `updatedAt`)
SELECT
	lower(hex(randomblob(12))),
	`Organization`.`id`,
	lower(`Organization`.`customDomain`),
	1,
	'cname',
	`Organization`.`cloudflareHostnameId`,
	CASE
		WHEN `Organization`.`customDomainStatus` IN ('active', 'pending', 'moved', 'blocked', 'error', 'expired') THEN `Organization`.`customDomainStatus`
		WHEN `Organization`.`customDomainStatus` IS NULL THEN 'pending'
		ELSE 'error'
	END,
	CASE WHEN `Organization`.`customDomainStatus` IS NULL OR `Organization`.`customDomainStatus` = 'pending' THEN CAST(strftime('%s', 'now') AS integer) * 1000 ELSE NULL END,
	CAST(strftime('%s', 'now') AS integer) * 1000,
	CAST(strftime('%s', 'now') AS integer) * 1000
FROM `Organization`
WHERE `Organization`.`customDomain` IS NOT NULL
	AND `Organization`.`customDomain` <> ''
	AND NOT EXISTS (SELECT 1 FROM `SiteDomain` AS `existing` WHERE `existing`.`hostname` = lower(`Organization`.`customDomain`));

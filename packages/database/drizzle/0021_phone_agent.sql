CREATE TABLE `PhoneAgent` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`settings` text NOT NULL,
	`publishedFlowVersionId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `PhoneAgent_organizationId_key` ON `PhoneAgent` (`organizationId`);--> statement-breakpoint
CREATE TABLE `PhoneAgentFlowVersion` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`version` integer NOT NULL,
	`graph` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`createdById` text,
	`publishedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `PhoneAgentFlowVersion_organizationId_version_key` ON `PhoneAgentFlowVersion` (`organizationId`,`version`);--> statement-breakpoint
CREATE TABLE `PhoneAgentNumber` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`scopeId` text,
	`platformNumberId` text,
	`e164` text NOT NULL,
	`mode` text DEFAULT 'forwarding' NOT NULL,
	`forwardedFrom` text,
	`isActive` integer DEFAULT true NOT NULL,
	`verifiedAt` integer,
	`verificationCodeHash` text,
	`verificationExpiresAt` integer,
	`verificationAttempts` integer DEFAULT 0 NOT NULL,
	`verificationSentAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`platformNumberId`) REFERENCES `PlatformPhoneNumber`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `PhoneAgentNumber_organizationId_idx` ON `PhoneAgentNumber` (`organizationId`);--> statement-breakpoint
CREATE UNIQUE INDEX `PhoneAgentNumber_e164_key` ON `PhoneAgentNumber` (`e164`);--> statement-breakpoint
CREATE UNIQUE INDEX `PhoneAgentNumber_platformNumberId_key` ON `PhoneAgentNumber` (`platformNumberId`);--> statement-breakpoint
CREATE TABLE `PhoneAgentTrainingRule` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`scopeId` text,
	`category` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`isActive` integer DEFAULT true NOT NULL,
	`sortOrder` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `PhoneAgentTrainingRule_organizationId_idx` ON `PhoneAgentTrainingRule` (`organizationId`);--> statement-breakpoint
CREATE TABLE `PlatformPhoneNumber` (
	`id` text PRIMARY KEY NOT NULL,
	`e164` text NOT NULL,
	`label` text,
	`provider` text DEFAULT 'twilio' NOT NULL,
	`assignedOrganizationId` text,
	`assignedAt` integer,
	`retiredAt` integer,
	`releasedAt` integer,
	`releasedFromOrganizationId` text,
	`releasedWithVerifiedForwarding` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`assignedOrganizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `PlatformPhoneNumber_e164_key` ON `PlatformPhoneNumber` (`e164`);--> statement-breakpoint
CREATE INDEX `PlatformPhoneNumber_assignedOrganizationId_idx` ON `PlatformPhoneNumber` (`assignedOrganizationId`);--> statement-breakpoint
-- Configuring the agent, viewing calls, and following up on or deleting calls
-- are separate permissions because call history includes caller numbers,
-- transcripts, and recordings.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_phone_agent_any', 'read', 'phone_agent', 'any', 'organization', 'View the AI phone agent setup', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_phone_agent_any', 'update', 'phone_agent', 'any', 'organization', 'Configure the AI phone agent, its call flow, numbers, and training rules', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_phone_call_any', 'read', 'phone_call', 'any', 'organization', 'View AI phone calls, transcripts, and recordings', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_phone_call_any', 'update', 'phone_call', 'any', 'organization', 'Complete and reopen AI phone calls and requests, and tag calls', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_delete_phone_call_any', 'delete', 'phone_call', 'any', 'organization', 'Permanently delete AI phone calls and their recordings', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_phone_agent_any'),
	('org_role_admin', 'org_perm_update_phone_agent_any'),
	('org_role_admin', 'org_perm_read_phone_call_any'),
	('org_role_admin', 'org_perm_update_phone_call_any'),
	('org_role_admin', 'org_perm_delete_phone_call_any');
CREATE TABLE `FormAlertDigest` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`formId` text NOT NULL,
	`lastEmailedAt` integer,
	`pendingCount` integer DEFAULT 0 NOT NULL,
	`formName` text DEFAULT '' NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `FormAlertDigest_organizationId_userId_formId_key` ON `FormAlertDigest` (`organizationId`,`userId`,`formId`);--> statement-breakpoint
CREATE INDEX `FormAlertDigest_pending_idx` ON `FormAlertDigest` (`pendingCount`);--> statement-breakpoint
CREATE TABLE `SiteExperiment` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`pageId` text NOT NULL,
	`sectionId` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`variantConfig` text NOT NULL,
	`startedAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`endedAt` integer,
	`endReason` text,
	`winner` text,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`pageId`) REFERENCES `WebsitePage`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `SiteExperiment_organizationId_status_idx` ON `SiteExperiment` (`organizationId`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `SiteExperiment_pageId_running_key` ON `SiteExperiment` (`pageId`) WHERE "SiteExperiment"."status" = 'running';--> statement-breakpoint
CREATE TABLE `SitePopup` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`buttonLabel` text DEFAULT '' NOT NULL,
	`buttonUrl` text,
	`imageUrl` text,
	`discountId` text,
	`trigger` text DEFAULT 'delay' NOT NULL,
	`triggerValue` integer DEFAULT 5 NOT NULL,
	`frequency` text DEFAULT 'day' NOT NULL,
	`pages` text DEFAULT '["all"]' NOT NULL,
	`startsAt` integer,
	`endsAt` integer,
	`captureContact` text DEFAULT 'none' NOT NULL,
	`consentText` text DEFAULT '' NOT NULL,
	`createdById` text,
	`publishedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`discountId`) REFERENCES `Discount`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `SitePopup_organizationId_status_idx` ON `SitePopup` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `SitePopup_discountId_idx` ON `SitePopup` (`discountId`);--> statement-breakpoint
-- Reading, exporting and unrestricting the responses of a restricted website
-- form (#357). Built-in admins (the owner's preset) receive it; plain members
-- and existing custom roles are deliberately NOT granted it and it can be given
-- to a custom role in the role editor.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_form_restricted_any', 'read', 'form_restricted', 'any', 'organization', 'Read, export and unrestrict responses of restricted website forms', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_form_restricted_any');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'website.popups', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'website.popups' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'website.funnel', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'website.funnel' AND "level" = 'system');

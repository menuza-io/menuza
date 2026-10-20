CREATE TABLE `JobPosting` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`positionName` text NOT NULL,
	`employmentType` text DEFAULT 'part_time' NOT NULL,
	`payType` text DEFAULT 'none' NOT NULL,
	`payMinMinor` integer,
	`payMaxMinor` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`descriptionHtml` text DEFAULT '' NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`isGeneral` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`publishedAt` integer,
	`closedAt` integer,
	`expiresAt` integer,
	`createdByUserId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `JobPosting_organizationId_slug_key` ON `JobPosting` (`organizationId`,`slug`);--> statement-breakpoint
CREATE INDEX `JobPosting_organizationId_status_idx` ON `JobPosting` (`organizationId`,`status`);--> statement-breakpoint
CREATE INDEX `JobPosting_status_expiresAt_idx` ON `JobPosting` (`status`,`expiresAt`);--> statement-breakpoint
CREATE TABLE `StaffingOutbox` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`nextAttemptAt` integer NOT NULL,
	`lastError` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `StaffingOutbox_status_nextAttemptAt_idx` ON `StaffingOutbox` (`status`,`nextAttemptAt`);--> statement-breakpoint
CREATE INDEX `StaffingOutbox_organizationId_idx` ON `StaffingOutbox` (`organizationId`);--> statement-breakpoint
ALTER TABLE `Organization` ADD `staffingTimeZone` text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE `OrganizationInvitation` ADD `staffMemberId` text;
--> statement-breakpoint
-- permissions (they mean nothing until a login is linked to a staff record).
-- Existing custom roles are deliberately NOT granted anything: unlike earlier
-- permission migrations, staffing has no safe analogue to copy from (even
-- read:member:any must not imply wage or schedule access), so organization
-- admins grant staffing permissions explicitly. Every staffing surface is also
-- behind the org-level staffing.* feature flags, which default to off.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_staff_any', 'read', 'staff', 'any', 'organization', 'View the staff roster, profiles, positions, and assignments', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_staff_any', 'update', 'staff', 'any', 'organization', 'Add, edit, and terminate staff, reset PINs, and manage onboarding templates', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_staff_pay_any', 'read', 'staff_pay', 'any', 'organization', 'View individual pay rates and wage history', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_staff_pay_any', 'update', 'staff_pay', 'any', 'organization', 'Change individual pay rates and salary details', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_staff_private_any', 'read', 'staff_private', 'any', 'organization', 'View staff dates of birth, addresses, emergency contacts, and documents', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_staff_private_any', 'update', 'staff_private', 'any', 'organization', 'Edit staff dates of birth, addresses, emergency contacts, and documents', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_schedule_any', 'read', 'schedule', 'any', 'organization', 'View the team schedule, availability, and time-off requests', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_schedule_any', 'update', 'schedule', 'any', 'organization', 'Create, edit, and publish shifts, manage templates, and decide availability and time-off requests', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_schedule_own', 'read', 'schedule', 'own', 'organization', 'View your own published shifts', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_create_timeclock_own', 'create', 'timeclock', 'own', 'organization', 'Clock yourself in and out', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_timesheet_any', 'read', 'timesheet', 'any', 'organization', 'View time cards and hours', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_timesheet_any', 'update', 'timesheet', 'any', 'organization', 'Add and edit time cards and export hours', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_approve_timesheet_any', 'approve', 'timesheet', 'any', 'organization', 'Approve, lock, and unlock time cards', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_labor_any', 'read', 'labor', 'any', 'organization', 'View labor cost and labor percentage', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_labor_policy_any', 'read', 'labor_policy', 'any', 'organization', 'View labor policies, kiosks, and pay periods', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_labor_policy_any', 'update', 'labor_policy', 'any', 'organization', 'Change labor policies, pair kiosks, and set pay periods', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_hiring_any', 'read', 'hiring', 'any', 'organization', 'View job posts and applicants', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_hiring_any', 'update', 'hiring', 'any', 'organization', 'Manage job posts, move applicants between stages, and hire', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_staff_any'),
	('org_role_admin', 'org_perm_update_staff_any'),
	('org_role_admin', 'org_perm_read_staff_pay_any'),
	('org_role_admin', 'org_perm_update_staff_pay_any'),
	('org_role_admin', 'org_perm_read_staff_private_any'),
	('org_role_admin', 'org_perm_update_staff_private_any'),
	('org_role_admin', 'org_perm_read_schedule_any'),
	('org_role_admin', 'org_perm_update_schedule_any'),
	('org_role_admin', 'org_perm_read_schedule_own'),
	('org_role_admin', 'org_perm_create_timeclock_own'),
	('org_role_admin', 'org_perm_read_timesheet_any'),
	('org_role_admin', 'org_perm_update_timesheet_any'),
	('org_role_admin', 'org_perm_approve_timesheet_any'),
	('org_role_admin', 'org_perm_read_labor_any'),
	('org_role_admin', 'org_perm_read_labor_policy_any'),
	('org_role_admin', 'org_perm_update_labor_policy_any'),
	('org_role_admin', 'org_perm_read_hiring_any'),
	('org_role_admin', 'org_perm_update_hiring_any'),
	('org_role_member', 'org_perm_read_schedule_own'),
	('org_role_member', 'org_perm_create_timeclock_own');

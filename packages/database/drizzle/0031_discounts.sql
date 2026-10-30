CREATE TABLE `Discount` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`name` text NOT NULL,
	`internalName` text,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`application` text NOT NULL,
	`valueType` text NOT NULL,
	`percentBp` integer,
	`amountMinor` integer,
	`currency` text,
	`maxDiscountMinor` integer,
	`target` text NOT NULL,
	`requirement` text,
	`quantityRule` text DEFAULT '{"kind":"none"}' NOT NULL,
	`maxDiscountedUnits` integer,
	`minSubtotalMinor` integer,
	`locationIds` text,
	`channels` text DEFAULT '["web","qr","pos","app"]' NOT NULL,
	`fulfillments` text DEFAULT '["pickup","delivery","dine_in"]' NOT NULL,
	`includeDrops` integer DEFAULT false NOT NULL,
	`schedule` text,
	`startsAt` text,
	`endsAt` text,
	`eligibility` text DEFAULT 'everyone' NOT NULL,
	`totalLimit` integer,
	`perCustomerLimit` text,
	`combinable` integer DEFAULT false NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`promoteOnMenu` integer DEFAULT false NOT NULL,
	`requireApproval` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`createdById` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `Discount_organizationId_status_idx` ON `Discount` (`organizationId`,`status`);--> statement-breakpoint
CREATE TABLE `DiscountCode` (
	`id` text PRIMARY KEY NOT NULL,
	`organizationId` text NOT NULL,
	`discountId` text NOT NULL,
	`code` text NOT NULL,
	`normalizedCode` text NOT NULL,
	`maxUses` integer,
	`archivedAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`discountId`) REFERENCES `Discount`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `DiscountCode_discountId_idx` ON `DiscountCode` (`discountId`);--> statement-breakpoint
CREATE UNIQUE INDEX `DiscountCode_organizationId_normalizedCode_active_key` ON `DiscountCode` (`organizationId`,`normalizedCode`) WHERE "DiscountCode"."archivedAt" IS NULL;--> statement-breakpoint
ALTER TABLE `OrganizationMenuItem` ADD `excludeFromDiscounts` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Discount permissions, org_role_admin grants, and system-level false feature flags.
-- Custom roles and org_role_member are deliberately NOT granted anything; every
-- discount surface is also behind the org-level discounts.* feature flags.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_discount_any', 'read', 'discount', 'any', 'organization', 'View discounts and coupons and how often they were used', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_discount_any', 'update', 'discount', 'any', 'organization', 'Create, edit, pause and archive discounts and coupons', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_discount_any'),
	('org_role_admin', 'org_perm_update_discount_any');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'discounts.enabled', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'discounts.enabled' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'discounts.automatic', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'discounts.automatic' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'discounts.coupons', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'discounts.coupons' AND "level" = 'system');

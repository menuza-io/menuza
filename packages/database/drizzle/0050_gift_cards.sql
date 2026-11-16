CREATE TABLE `GiftCardSettings` (
	`organizationId` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`updatedById` text,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
-- Gift card permissions, org_role_admin grants, and system-level false feature
-- flags (gift_cards.enabled, gift_cards.online, gift_cards.pos). Existing custom
-- roles and org_role_member are deliberately NOT granted anything; every gift
-- card surface is also behind the org-level gift_cards.* feature flags. Codes,
-- balances and purchaser/recipient details live in the regional tenant database;
-- the control plane keeps only these permissions, the flags and the settings.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_gift_card_any', 'read', 'gift_card', 'any', 'organization', 'View gift cards, their balances and history, and the gift card reports', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_gift_card_any', 'update', 'gift_card', 'any', 'organization', 'Adjust and void gift cards, review held purchases, manage card stock and import cards', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_gift_card_charge_any', 'update', 'gift_card_charge', 'any', 'organization', 'Charge a gift card from the App for a phone, catering or invoice payment', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_gift_card_any'),
	('org_role_admin', 'org_perm_update_gift_card_any'),
	('org_role_admin', 'org_perm_update_gift_card_charge_any');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'gift_cards.enabled', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'gift_cards.enabled' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'gift_cards.online', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'gift_cards.online' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'gift_cards.pos', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'gift_cards.pos' AND "level" = 'system');

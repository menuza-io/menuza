-- Reservations permissions, org_role_admin grants, and system-level false feature flags.
-- Existing custom roles and org_role_member are deliberately NOT granted anything;
-- every reservations surface is also behind the org-level reservations.* feature flags.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_reservation_any', 'read', 'reservation', 'any', 'organization', 'View the reservation book, timeline, floor plan, calendar, overview, and waitlist', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_reservation_any', 'update', 'reservation', 'any', 'organization', 'Create, modify, seat, and manage reservations, walk-ins, waitlist, service notes, and section assignments', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_reservation_settings_any', 'read', 'reservation_settings', 'any', 'organization', 'View reservation setup, floor plan, services, policies, messages, sections, and experiences', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_reservation_settings_any', 'update', 'reservation_settings', 'any', 'organization', 'Edit reservation setup, floor plan, services, blocks, policies, messages, sections, and experiences', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_reservation_guest_any', 'read', 'reservation_guest', 'any', 'organization', 'View guestbook profiles, visit history, notes, and exports', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_reservation_guest_any', 'update', 'reservation_guest', 'any', 'organization', 'Edit guestbook profiles, tags, notes, and merge or erase guests', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_reservation_report_any', 'read', 'reservation_report', 'any', 'organization', 'View reservation reports and analytics', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_reservation_payment_any', 'update', 'reservation_payment', 'any', 'organization', 'Charge cancellation or no-show fees and request reservation refunds', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_reservation_any'),
	('org_role_admin', 'org_perm_update_reservation_any'),
	('org_role_admin', 'org_perm_read_reservation_settings_any'),
	('org_role_admin', 'org_perm_update_reservation_settings_any'),
	('org_role_admin', 'org_perm_read_reservation_guest_any'),
	('org_role_admin', 'org_perm_update_reservation_guest_any'),
	('org_role_admin', 'org_perm_read_reservation_report_any'),
	('org_role_admin', 'org_perm_update_reservation_payment_any');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reservations.enabled', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reservations.enabled' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reservations.online', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reservations.online' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reservations.waitlist', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reservations.waitlist' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reservations.payments', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reservations.payments' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reservations.experiences', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reservations.experiences' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reservations.voice', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reservations.voice' AND "level" = 'system');
--> statement-breakpoint
-- Reservations platform fee default: 250 basis points (2.50%), stored as a JSON integer.
-- The mission docs said 0; the product owner decided on 250. Idempotent via NOT EXISTS.
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'reservations.platform_fee_bp', '250', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'reservations.platform_fee_bp' AND "level" = 'system');

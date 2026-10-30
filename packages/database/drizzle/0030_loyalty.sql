-- Loyalty permissions, org_role_admin grants, and system-level false feature flags (loyalty.enabled and loyalty.redemption; the marketing
-- filters are not built, so their flag arrives with them).
-- Existing custom roles and org_role_member are deliberately NOT granted anything;
-- every loyalty surface is also behind the org-level loyalty.* feature flags.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_loyalty_any', 'read', 'loyalty', 'any', 'organization', 'View loyalty members, balances, point activity, and redemptions', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_loyalty_program_any', 'update', 'loyalty_program', 'any', 'organization', 'Edit the loyalty program and its rewards', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_loyalty_points_any', 'update', 'loyalty_points', 'any', 'organization', 'Adjust member points with a recorded reason', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_loyalty_redemption_any', 'update', 'loyalty_redemption', 'any', 'organization', 'Resolve redemptions and purchases waiting for review, record refunds, and repair balances', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_loyalty_report_any', 'read', 'loyalty_report', 'any', 'organization', 'View loyalty reports and analytics', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_loyalty_any'),
	('org_role_admin', 'org_perm_update_loyalty_program_any'),
	('org_role_admin', 'org_perm_update_loyalty_points_any'),
	('org_role_admin', 'org_perm_update_loyalty_redemption_any'),
	('org_role_admin', 'org_perm_read_loyalty_report_any');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'loyalty.enabled', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'loyalty.enabled' AND "level" = 'system');--> statement-breakpoint
INSERT INTO "ConfigFlag" ("id", "key", "value", "level", "organizationId", "userId", "createdAt", "updatedAt")
SELECT lower(hex(randomblob(12))), 'loyalty.redemption', 'false', 'system', NULL, NULL, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM "ConfigFlag" WHERE "key" = 'loyalty.redemption' AND "level" = 'system');

-- Restaurant menu catalog and location-scoped operator permissions (Manuza MVP).
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_menu_any', 'read', 'menu', 'any', 'organization', 'View restaurant menu categories and items', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_menu_any', 'update', 'menu', 'any', 'organization', 'Create and edit restaurant menu categories and items', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_location_any', 'read', 'location', 'any', 'organization', 'View restaurant locations and branch settings', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_location_any', 'update', 'location', 'any', 'organization', 'Create and edit restaurant locations', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_menu_any'),
	('org_role_admin', 'org_perm_update_menu_any'),
	('org_role_admin', 'org_perm_read_location_any'),
	('org_role_admin', 'org_perm_update_location_any');--> statement-breakpoint
-- Members can read menu/locations; writes stay admin-only until staff/manager roles ship.
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_member', 'org_perm_read_menu_any'),
	('org_role_member', 'org_perm_read_location_any'),
	('org_role_viewer', 'org_perm_read_menu_any'),
	('org_role_viewer', 'org_perm_read_location_any');--> statement-breakpoint
-- Custom roles that could manage settings inherit location + menu write (mirrors website split).
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B")
	SELECT "A", 'org_perm_read_location_any' FROM "_OrganizationPermissionToRole" WHERE "B" = 'org_perm_read_settings_any';--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B")
	SELECT "A", 'org_perm_update_location_any' FROM "_OrganizationPermissionToRole" WHERE "B" = 'org_perm_update_settings_any';--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B")
	SELECT "A", 'org_perm_read_menu_any' FROM "_OrganizationPermissionToRole" WHERE "B" = 'org_perm_read_settings_any';--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B")
	SELECT "A", 'org_perm_update_menu_any' FROM "_OrganizationPermissionToRole" WHERE "B" = 'org_perm_update_settings_any';

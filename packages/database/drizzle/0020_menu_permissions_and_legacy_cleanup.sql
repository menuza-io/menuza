DROP TABLE `OrganizationMenuModifierOption`;--> statement-breakpoint
-- Menu management is now gated by its own organization permissions instead of
-- being implicitly available to every active member. Previously any active
-- member could create/edit/delete menus, categories, items, modifiers, and
-- drops. Built-in admin keeps full access; members and viewers keep read access
-- (they could always read menus); roles that could already manage the website
-- are copied so existing custom roles do not silently lose access.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_menu_any', 'read', 'menu', 'any', 'organization', 'View menus, categories, items, and modifiers', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_menu_any', 'update', 'menu', 'any', 'organization', 'Create, edit, publish, and delete menus and drops', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
-- Built-in organization admin keeps full access.
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_menu_any'),
	('org_role_admin', 'org_perm_update_menu_any');--> statement-breakpoint
-- Members and viewers could always read menus before permissions were enforced.
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_member', 'org_perm_read_menu_any'),
	('org_role_viewer', 'org_perm_read_menu_any');--> statement-breakpoint
-- Roles that could manage the website could also manage menus. Copy those grants
-- so existing custom roles do not silently lose access; admins can revoke the
-- menu permissions afterwards to scope roles more tightly.
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B")
	SELECT "A", 'org_perm_read_menu_any' FROM "_OrganizationPermissionToRole" WHERE "B" = 'org_perm_read_website_any';--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B")
	SELECT "A", 'org_perm_update_menu_any' FROM "_OrganizationPermissionToRole" WHERE "B" = 'org_perm_update_website_any';

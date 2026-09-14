-- Website announcements and marketing (broadcasts/automations) now have their
-- own organization permissions instead of being implied by the broad
-- read/update website permissions.
UPDATE "Permission" SET "description" = 'View website pages, forms, redirects, and analytics', "updatedAt" = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE "id" = 'org_perm_read_website_any';--> statement-breakpoint
UPDATE "Permission" SET "description" = 'Edit website pages, forms, redirects, and translations', "updatedAt" = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE "id" = 'org_perm_update_website_any';--> statement-breakpoint
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_announcement_any', 'read', 'announcement', 'any', 'organization', 'View website announcements', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_announcement_any', 'update', 'announcement', 'any', 'organization', 'Create, edit, publish, and delete website announcements', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_campaign_any', 'read', 'campaign', 'any', 'organization', 'View marketing broadcasts', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_campaign_any', 'update', 'campaign', 'any', 'organization', 'Create and send marketing broadcasts', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_automation_any', 'read', 'automation', 'any', 'organization', 'View marketing automations', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_automation_any', 'update', 'automation', 'any', 'organization', 'Create, edit, publish, and delete marketing automations', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
-- Built-in organization admin keeps full access.
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_announcement_any'),
	('org_role_admin', 'org_perm_update_announcement_any'),
	('org_role_admin', 'org_perm_read_campaign_any'),
	('org_role_admin', 'org_perm_update_campaign_any'),
	('org_role_admin', 'org_perm_read_automation_any'),
	('org_role_admin', 'org_perm_update_automation_any');--> statement-breakpoint
-- Members and viewers could already read marketing pages before permissions
-- were enforced, so keep their read access while write access now requires an
-- explicit update permission.
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_member', 'org_perm_read_campaign_any'),
	('org_role_member', 'org_perm_read_automation_any'),
	('org_role_viewer', 'org_perm_read_campaign_any'),
	('org_role_viewer', 'org_perm_read_automation_any');--> statement-breakpoint
-- Roles that could manage the website could also manage announcements. Copy
-- those grants so existing custom roles do not silently lose access; admins can
-- revoke the announcement permissions afterwards to scope roles more tightly.
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B")
	SELECT "A", 'org_perm_read_announcement_any' FROM "_OrganizationPermissionToRole" WHERE "B" = 'org_perm_read_website_any';--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B")
	SELECT "A", 'org_perm_update_announcement_any' FROM "_OrganizationPermissionToRole" WHERE "B" = 'org_perm_update_website_any';--> statement-breakpoint
-- Platform marketing (admin app) permissions. These use the system context and
-- are managed from the admin roles UI.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('sys_perm_read_platform_campaign_any', 'read', 'platform_campaign', 'any', 'system', 'View platform broadcasts', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('sys_perm_update_platform_campaign_any', 'update', 'platform_campaign', 'any', 'system', 'Create and send platform broadcasts', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('sys_perm_read_platform_automation_any', 'read', 'platform_automation', 'any', 'system', 'View platform automations', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('sys_perm_update_platform_automation_any', 'update', 'platform_automation', 'any', 'system', 'Create, edit, publish, and delete platform automations', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
-- Grant platform marketing permissions to the built-in admin role where it
-- already exists (seeded databases).
INSERT OR IGNORE INTO "_PermissionToRole" ("A", "B")
	SELECT 'sys_perm_read_platform_campaign_any', "id" FROM "Role" WHERE "name" = 'admin';--> statement-breakpoint
INSERT OR IGNORE INTO "_PermissionToRole" ("A", "B")
	SELECT 'sys_perm_update_platform_campaign_any', "id" FROM "Role" WHERE "name" = 'admin';--> statement-breakpoint
INSERT OR IGNORE INTO "_PermissionToRole" ("A", "B")
	SELECT 'sys_perm_read_platform_automation_any', "id" FROM "Role" WHERE "name" = 'admin';--> statement-breakpoint
INSERT OR IGNORE INTO "_PermissionToRole" ("A", "B")
	SELECT 'sys_perm_update_platform_automation_any', "id" FROM "Role" WHERE "name" = 'admin';

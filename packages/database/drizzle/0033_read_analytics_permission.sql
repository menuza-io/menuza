-- read:analytics:any was checked by report access but never stored, so granting
-- it could not open reports. Built-in admins receive it. Custom roles can be
-- given it from the role editor without also receiving settings access.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_analytics_any', 'read', 'analytics', 'any', 'organization', 'Run organization reports', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_analytics_any');

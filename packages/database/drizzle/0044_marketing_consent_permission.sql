-- Recording a guest's marketing consent on their behalf (Customers, a person's
-- profile). Built-in admins receive it. Plain members and existing custom roles
-- are deliberately NOT granted it; it can be given to a custom role in the role
-- editor. It acts only together with read:settings:any (the customers facet)
-- and is never usable while impersonating.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_update_marketing_consent_any', 'update', 'marketing_consent', 'any', 'organization', 'Record a guest''s marketing consent given in person, on a paper form, or by phone', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_update_marketing_consent_any');

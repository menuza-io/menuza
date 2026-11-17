ALTER TABLE `OrganizationLocation` ADD `stationSettings` text;--> statement-breakpoint
ALTER TABLE `OrganizationLocation` ADD `orderNumberFormat` text;--> statement-breakpoint
-- Closing an open cash drawer shift from the App (#403). Built-in admins
-- receive it by default; custom roles can be granted it in the role editor.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_update_pos_shift_any', 'update', 'pos_shift', 'any', 'organization', 'Close an open cash drawer shift from the App', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_update_pos_shift_any');
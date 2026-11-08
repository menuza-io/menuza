-- The media library and AI photo studio were open to every member, viewers
-- and guests included. Changing the shared library and using the studio now
-- need these permissions. Built-in admins and members receive both, so they
-- keep what they had; custom roles can be given them in the role editor.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_update_media_any', 'update', 'media', 'any', 'organization', 'Upload, edit, replace, and delete media library files', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_create_media_studio_any', 'create', 'media_studio', 'any', 'organization', 'Create images with the AI photo studio', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_update_media_any'),
	('org_role_admin', 'org_perm_create_media_studio_any'),
	('org_role_member', 'org_perm_update_media_any'),
	('org_role_member', 'org_perm_create_media_studio_any');

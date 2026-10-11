-- Staffing permissions. Staff records live in the regional tenant database;
-- these rows only gate which operators may mint staffing credentials. Only the
-- built-in admin role receives them. Member/viewer defaults and existing custom
-- roles are unchanged; admins grant them to custom roles explicitly.
INSERT OR IGNORE INTO "Permission" ("id", "action", "entity", "access", "context", "description", "createdAt", "updatedAt") VALUES
	('org_perm_read_staff_any', 'read', 'staff', 'any', 'organization', 'View the staff roster, positions, and locations', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_staff_any', 'update', 'staff', 'any', 'organization', 'Add, edit, terminate, and rehire staff, and reset PINs', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_schedule_any', 'read', 'schedule', 'any', 'organization', 'View staff schedules and publish history', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_schedule_any', 'update', 'schedule', 'any', 'organization', 'Create, edit, copy, and publish staff schedules', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_timeclock_any', 'read', 'timeclock', 'any', 'organization', 'View timesheets and paired time clock devices', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_timeclock_any', 'update', 'timeclock', 'any', 'organization', 'Edit and approve time cards, and pair or revoke time clocks', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_hiring_any', 'read', 'hiring', 'any', 'organization', 'View job postings and applicants', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_update_hiring_any', 'update', 'hiring', 'any', 'organization', 'Manage job postings, applicants, and hires', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
	('org_perm_read_staff_pay_any', 'read', 'staff_pay', 'any', 'organization', 'View and set staff pay rates and labor cost', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);--> statement-breakpoint
INSERT OR IGNORE INTO "_OrganizationPermissionToRole" ("A", "B") VALUES
	('org_role_admin', 'org_perm_read_staff_any'),
	('org_role_admin', 'org_perm_update_staff_any'),
	('org_role_admin', 'org_perm_read_schedule_any'),
	('org_role_admin', 'org_perm_update_schedule_any'),
	('org_role_admin', 'org_perm_read_timeclock_any'),
	('org_role_admin', 'org_perm_update_timeclock_any'),
	('org_role_admin', 'org_perm_read_hiring_any'),
	('org_role_admin', 'org_perm_update_hiring_any'),
	('org_role_admin', 'org_perm_read_staff_pay_any');

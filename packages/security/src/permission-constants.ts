/**
 * Frontend permission constants that mirror the server-side ones
 * Used with the client-side permission hooks and components
 */

// Note permissions
export const PERMISSIONS = {
	// Note permissions
	CREATE_NOTE_OWN: 'create:note:own',
	READ_NOTE_OWN: 'read:note:own',
	READ_NOTE_ANY: 'read:note:org',
	UPDATE_NOTE_OWN: 'update:note:own',
	UPDATE_NOTE_ANY: 'update:note:org',
	DELETE_NOTE_OWN: 'delete:note:own',
	DELETE_NOTE_ANY: 'delete:note:org',

	// Member permissions
	READ_MEMBER_ANY: 'read:member:any',
	CREATE_MEMBER_ANY: 'create:member:any',
	UPDATE_MEMBER_ANY: 'update:member:any',
	DELETE_MEMBER_ANY: 'delete:member:any',

	// Settings permissions
	READ_SETTINGS_ANY: 'read:settings:any',
	UPDATE_SETTINGS_ANY: 'update:settings:any',

	// Website permissions
	READ_WEBSITE_ANY: 'read:website:any',
	UPDATE_WEBSITE_ANY: 'update:website:any',

	// Analytics permissions
	READ_ANALYTICS_ANY: 'read:analytics:any',

	// Staffing permissions
	READ_STAFF_ANY: 'read:staff:any',
	UPDATE_STAFF_ANY: 'update:staff:any',
	READ_STAFF_PAY_ANY: 'read:staff_pay:any',
	UPDATE_STAFF_PAY_ANY: 'update:staff_pay:any',
	READ_STAFF_PRIVATE_ANY: 'read:staff_private:any',
	UPDATE_STAFF_PRIVATE_ANY: 'update:staff_private:any',
	READ_SCHEDULE_ANY: 'read:schedule:any',
	UPDATE_SCHEDULE_ANY: 'update:schedule:any',
	READ_SCHEDULE_OWN: 'read:schedule:own',
	CREATE_TIMECLOCK_OWN: 'create:timeclock:own',
	READ_TIMESHEET_ANY: 'read:timesheet:any',
	UPDATE_TIMESHEET_ANY: 'update:timesheet:any',
	APPROVE_TIMESHEET_ANY: 'approve:timesheet:any',
	READ_LABOR_ANY: 'read:labor:any',
	READ_LABOR_POLICY_ANY: 'read:labor_policy:any',
	UPDATE_LABOR_POLICY_ANY: 'update:labor_policy:any',
	READ_HIRING_ANY: 'read:hiring:any',
	UPDATE_HIRING_ANY: 'update:hiring:any',
} as const

export type PermissionKey = keyof typeof PERMISSIONS
export type PermissionValue = (typeof PERMISSIONS)[PermissionKey]

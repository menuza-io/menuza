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

	// Menu permissions
	READ_MENU_ANY: 'read:menu:any',
	UPDATE_MENU_ANY: 'update:menu:any',
} as const

export type PermissionKey = keyof typeof PERMISSIONS
export type PermissionValue = (typeof PERMISSIONS)[PermissionKey]

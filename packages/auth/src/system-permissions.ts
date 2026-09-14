/**
 * Platform-level (system context) permission strings.
 *
 * These are checked against a user's global roles (`Role` + `_PermissionToRole`)
 * rather than their organization membership, and are used by the admin app.
 */
export const SYSTEM_PERMISSIONS = {
	// Platform marketing broadcasts
	READ_PLATFORM_CAMPAIGN_ANY: 'read:platform_campaign:any' as const,
	UPDATE_PLATFORM_CAMPAIGN_ANY: 'update:platform_campaign:any' as const,

	// Platform marketing automations
	READ_PLATFORM_AUTOMATION_ANY: 'read:platform_automation:any' as const,
	UPDATE_PLATFORM_AUTOMATION_ANY: 'update:platform_automation:any' as const,
} as const

export type SystemPermissionString =
	(typeof SYSTEM_PERMISSIONS)[keyof typeof SYSTEM_PERMISSIONS]

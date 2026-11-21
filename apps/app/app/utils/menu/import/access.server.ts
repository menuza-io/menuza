import { getFeatureFlag } from '@repo/common/feature-flags'
import { isMenuFlagOn } from '#app/utils/menu/menu-flags.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

/** Feature flag key for #73 AI menu import (default off). */
export const MENU_IMPORT_FLAG_KEY = 'menu.import'

/**
 * Kill switch for AI menu import (`MENU_IMPORT_ENABLED`). Unset means on.
 * Returns true when the kill switch has shut the feature off.
 */
export function isMenuImportKillSwitchOn(
	env: { MENU_IMPORT_ENABLED?: string } = process.env as {
		MENU_IMPORT_ENABLED?: string
	},
): boolean {
	const raw = env.MENU_IMPORT_ENABLED?.trim().toLowerCase()
	if (!raw) return false
	return raw === 'false' || raw === '0' || raw === 'off' || raw === 'no'
}

export async function getMenuImportEnabled(organizationId: string) {
	return isMenuFlagOn(
		await getFeatureFlag(MENU_IMPORT_FLAG_KEY, { organizationId }),
	)
}

export async function requireMenuImportAccess(
	request: Request,
	organizationId: string,
): Promise<string> {
	const userId = await requireUserWithOrganizationPermission(
		request,
		organizationId,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
	const enabled = await getMenuImportEnabled(organizationId)
	if (!enabled) {
		throw new Response('Not Found', { status: 404 })
	}
	return userId
}

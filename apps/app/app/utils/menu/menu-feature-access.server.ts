import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import { isMenuFlagOn, MENU_FLAG_KEYS } from './menu-flags.ts'

export async function requireMenuHistoryAccess(
	request: Request,
	organizationId: string,
) {
	const userId = await requireUserWithOrganizationPermission(
		request,
		organizationId,
		ORG_PERMISSIONS.READ_MENU_ANY,
	)
	const enabled = isMenuFlagOn(
		await getFeatureFlag(MENU_FLAG_KEYS.history, { organizationId }),
	)
	if (!enabled) {
		throw new Response('Not Found', { status: 404 })
	}
	return userId
}

export async function getMenuHistoryEnabled(organizationId: string) {
	return isMenuFlagOn(
		await getFeatureFlag(MENU_FLAG_KEYS.history, { organizationId }),
	)
}

export async function requireMenuBulkEditAccess(
	request: Request,
	organizationId: string,
) {
	const userId = await requireUserWithOrganizationPermission(
		request,
		organizationId,
		ORG_PERMISSIONS.READ_MENU_ANY,
	)
	const enabled = isMenuFlagOn(
		await getFeatureFlag(MENU_FLAG_KEYS.bulkEdit, { organizationId }),
	)
	if (!enabled) {
		throw new Response('Not Found', { status: 404 })
	}
	return userId
}

export async function getMenuBulkEditEnabled(organizationId: string) {
	return isMenuFlagOn(
		await getFeatureFlag(MENU_FLAG_KEYS.bulkEdit, { organizationId }),
	)
}

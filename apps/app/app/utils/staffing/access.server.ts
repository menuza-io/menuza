import {
	getUserId,
	isImpersonating,
	type OrganizationPermissionString,
	userHasOrganizationPermission,
} from '@repo/auth'
import { getFeatureFlags } from '@repo/common/feature-flags'
import {
	resolveStaffingFlags,
	STAFFING_FLAGS,
	type StaffingAccessLevel,
	type StaffingArea,
	type StaffingFlags,
} from '@repo/staffing'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

const AREA_PERMISSIONS: Record<
	StaffingArea,
	{ read: OrganizationPermissionString; write: OrganizationPermissionString }
> = {
	staff: {
		read: ORG_PERMISSIONS.READ_STAFF_ANY,
		write: ORG_PERMISSIONS.UPDATE_STAFF_ANY,
	},
	schedule: {
		read: ORG_PERMISSIONS.READ_SCHEDULE_ANY,
		write: ORG_PERMISSIONS.UPDATE_SCHEDULE_ANY,
	},
	timeclock: {
		read: ORG_PERMISSIONS.READ_TIMECLOCK_ANY,
		write: ORG_PERMISSIONS.UPDATE_TIMECLOCK_ANY,
	},
}

/** The flag that must be on (besides `staffing.enabled`) for each area. */
export const STAFFING_AREA_FLAG: Record<StaffingArea, keyof StaffingFlags> = {
	staff: 'enabled',
	schedule: 'scheduling',
	timeclock: 'timeclock',
}

/**
 * Organization and system flags only: a user-level flag must not switch on a
 * regional workforce store for an organization.
 */
export async function getStaffingFlags(organizationId: string) {
	const raw = await getFeatureFlags(Object.values(STAFFING_FLAGS), {
		organizationId,
	})
	return resolveStaffingFlags({
		enabled: raw[STAFFING_FLAGS.enabled],
		scheduling: raw[STAFFING_FLAGS.scheduling],
		timeclock: raw[STAFFING_FLAGS.timeclock],
		pay: raw[STAFFING_FLAGS.pay],
		hiring: raw[STAFFING_FLAGS.hiring],
		onboarding: raw[STAFFING_FLAGS.onboarding],
	})
}

export type StaffingGrants = Record<StaffingArea, StaffingAccessLevel | null>

export type StaffingAccess = {
	orgId: string
	userId: string
	dataRegion: string
	flags: StaffingFlags
	grants: StaffingGrants
	impersonating: boolean
	/** `read:staff_pay:any` plus roster read and the `staffing.pay` flag. */
	canViewPay: boolean
}

/**
 * Write requires both the read and the update permission, so an update-only
 * custom role cannot mint credentials that read staff data.
 */
async function areaGrant(
	userId: string,
	orgId: string,
	area: StaffingArea,
): Promise<StaffingAccessLevel | null> {
	const [canRead, canWrite] = await Promise.all([
		userHasOrganizationPermission(userId, orgId, AREA_PERMISSIONS[area].read),
		userHasOrganizationPermission(userId, orgId, AREA_PERMISSIONS[area].write),
	])
	if (!canRead) return null
	return canWrite ? 'write' : 'read'
}

export async function getStaffingAccess(
	request: Request,
	orgSlug: string | undefined,
): Promise<StaffingAccess> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		dataRegion: true,
	})
	const userId = await getUserId(request)
	if (!userId) throw new Response('Unauthorized', { status: 401 })
	const orgId = organization.id!
	const flags = await getStaffingFlags(orgId)
	const grants: StaffingGrants = {
		staff: null,
		schedule: null,
		timeclock: null,
	}
	const impersonating = await isImpersonating(request)
	if (flags.enabled) {
		const areas = (Object.keys(STAFFING_AREA_FLAG) as StaffingArea[]).filter(
			(area) => flags[STAFFING_AREA_FLAG[area]],
		)
		const levels = await Promise.all(
			areas.map((area) => areaGrant(userId, orgId, area)),
		)
		areas.forEach((area, index) => {
			const level = levels[index] ?? null
			// Support impersonation may look, but never changes workforce records.
			grants[area] = impersonating && level === 'write' ? 'read' : level
		})
	}
	return {
		orgId,
		userId,
		dataRegion: organization.dataRegion ?? 'us',
		flags,
		grants,
		impersonating,
		canViewPay:
			flags.pay &&
			!impersonating &&
			grants.staff !== null &&
			(await userHasOrganizationPermission(
				userId,
				orgId,
				ORG_PERMISSIONS.READ_STAFF_PAY_ANY,
			)),
	}
}

/**
 * Every staffing loader, action, and token route calls this independently:
 * React Router can skip parent loaders. A disabled flag looks like a missing
 * page (404); a missing permission is 403.
 */
export async function requireStaffingFeature(
	request: Request,
	orgSlug: string | undefined,
	area: StaffingArea,
	level: StaffingAccessLevel = 'read',
) {
	const access = await getStaffingAccess(request, orgSlug)
	if (!access.flags[STAFFING_AREA_FLAG[area]]) {
		throw new Response('Not found', { status: 404 })
	}
	const granted = access.grants[area]
	if (!granted || (level === 'write' && granted !== 'write')) {
		throw new Response('Forbidden', { status: 403 })
	}
	return access
}

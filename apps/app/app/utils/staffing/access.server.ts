import { getUserId, getUserOrganizationPermissions } from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	grantsSatisfying,
	isFlagOn,
	STAFFING_FLAG_KEYS,
	type StaffingFeature,
	type StaffingPermission,
	STAFFING_PERMISSIONS,
} from '@repo/staffing'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	HIDDEN_STAFFING_NAV,
	type StaffingNavAccess,
} from '#app/utils/staffing/nav.ts'
import { resolveStaffingScopeIds } from '#app/utils/staffing/scope-claim.server.ts'

/**
 * Staffing access: org-level feature flags first, then permissions.
 *
 * Every staffing surface is behind flags that default to OFF. `staffing.enabled`
 * is the master switch; `timeclock`, `scheduling`, `labor` and `hiring` only
 * count when the master is also on. A flag is on only when its stored value is
 * exactly `true`. The flag is enforced here, at token mint, and in every child
 * loader and action (parent loaders can be skipped on data requests, so each
 * child calls `requireStaffingAccess` itself). tenant-api honors only tokens the
 * App minted, so it needs no flag lookup.
 *
 * Failing a flag is a 404, not a 403: a module that is not turned on should
 * look like it does not exist. Failing a permission is a 403.
 */

export { HIDDEN_STAFFING_NAV, type StaffingNavAccess }

export type StaffingFeatureState = Record<StaffingFeature, boolean>

const FEATURES = Object.keys(STAFFING_FLAG_KEYS) as StaffingFeature[]

/** Effective state of every staffing feature for an organization. */
export async function getStaffingFeatureState(
	organizationId: string,
): Promise<StaffingFeatureState> {
	const values = await Promise.all(
		FEATURES.map((feature) =>
			getFeatureFlag(STAFFING_FLAG_KEYS[feature], { organizationId }),
		),
	)
	const raw = Object.fromEntries(
		FEATURES.map((feature, i) => [feature, isFlagOn(values[i])]),
	) as StaffingFeatureState
	const master = raw.enabled
	return {
		enabled: master,
		timeclock: master && raw.timeclock,
		scheduling: master && raw.scheduling,
		labor: master && raw.labor,
		hiring: master && raw.hiring,
	}
}

export async function isStaffingFeatureEnabled(
	organizationId: string,
	feature: StaffingFeature = 'enabled',
): Promise<boolean> {
	const master = await getFeatureFlag(STAFFING_FLAG_KEYS.enabled, {
		organizationId,
	})
	if (!isFlagOn(master)) return false
	if (feature === 'enabled') return true
	const child = await getFeatureFlag(STAFFING_FLAG_KEYS[feature], {
		organizationId,
	})
	return isFlagOn(child)
}

/** Throws a 404 unless the master flag and, if given, the feature flag are on. */
export async function requireStaffingFeature(
	organizationId: string,
	feature: StaffingFeature = 'enabled',
): Promise<void> {
	if (!(await isStaffingFeatureEnabled(organizationId, feature))) {
		throw new Response('Not Found', { status: 404 })
	}
}

type Grant = { action: string; entity: string; access: string }

function holdsAny(
	grants: readonly Grant[],
	required: readonly StaffingPermission[],
): boolean {
	return required.some((permission) => {
		const [action, entity, access] = permission.split(':')
		return grants.some(
			(g) => g.action === action && g.entity === entity && g.access === access,
		)
	})
}

/**
 * Whether a user's active role grants `permission`. A stronger grant (an
 * update or approve) also satisfies the matching read requirement.
 */
export async function userHasStaffingPermission(
	userId: string,
	organizationId: string,
	permission: StaffingPermission,
): Promise<boolean> {
	const grants = await getUserOrganizationPermissions(userId, organizationId)
	return holdsAny(grants, grantsSatisfying(permission))
}

export type StaffingAccessRequirement = {
	/** Defaults to the master `staffing.enabled` flag only. */
	feature?: StaffingFeature
	/** The user needs at least one of these (each may be satisfied by a stronger grant). */
	anyOf: readonly StaffingPermission[]
}

/**
 * The guard every staffing loader and action calls first. Order: signed-in
 * active member of the organization (404/401 otherwise), feature flags (404),
 * permission (403), then scope scope (403 when the member was limited to
 * selected scopes and none are selected: no staffing access at all).
 * Returns ids only, never staff data. `scopeIds` is the member's scope
 * scope (`null` means every workplace), the same value the token will carry.
 */
export async function requireStaffingAccess(
	request: Request,
	orgSlug: string | undefined,
	requirement: StaffingAccessRequirement,
) {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		dataRegion: true,
	})
	const organizationId = organization.id
	await requireStaffingFeature(organizationId, requirement.feature)

	const userId = await getUserId(request)
	if (!userId) throw new Response('Unauthorized', { status: 401 })
	const grants = await getUserOrganizationPermissions(userId, organizationId)
	const allowed = requirement.anyOf.some((permission) =>
		holdsAny(grants, grantsSatisfying(permission)),
	)
	if (!allowed) {
		throw new Response(
			`Forbidden: requires ${requirement.anyOf.join(' or ')}`,
			{
				status: 403,
			},
		)
	}
	const scopeIds = await resolveStaffingScopeIds(userId, organizationId)
	if (scopeIds !== null && scopeIds.length === 0) {
		throw new Response('Forbidden: no staffing workplaces', { status: 403 })
	}
	return {
		organizationId,
		userId,
		dataRegion: organization.dataRegion ?? 'us',
		grants: grants.filter((g) => isStaffingEntity(g.entity)),
		scopeIds,
	}
}

const STAFFING_ENTITIES: ReadonlySet<string> = new Set(
	Object.values(STAFFING_PERMISSIONS).map((p) => p.split(':')[1]!),
)

function isStaffingEntity(entity: string): boolean {
	return STAFFING_ENTITIES.has(entity)
}

/**
 * Sidebar visibility: a link shows only when its flag is on and the user holds
 * a matching permission. The whole group hides when nothing is visible, and
 * costs a single flag read when the master flag is off.
 */
export async function getStaffingNavAccess(
	userId: string,
	organizationId: string,
): Promise<StaffingNavAccess> {
	const master = await getFeatureFlag(STAFFING_FLAG_KEYS.enabled, {
		organizationId,
	})
	if (!isFlagOn(master)) return HIDDEN_STAFFING_NAV

	const [features, grants, scopeIds] = await Promise.all([
		getStaffingFeatureState(organizationId),
		getUserOrganizationPermissions(userId, organizationId),
		resolveStaffingScopeIds(userId, organizationId),
	])
	// Limited to selected scopes with none chosen: no staffing access.
	if (scopeIds !== null && scopeIds.length === 0) {
		return HIDDEN_STAFFING_NAV
	}
	const can = (...permissions: StaffingPermission[]) =>
		permissions.some((p) => holdsAny(grants, grantsSatisfying(p)))

	const team = features.enabled && can(STAFFING_PERMISSIONS.READ_STAFF)
	const timeclock =
		features.timeclock &&
		can(
			STAFFING_PERMISSIONS.READ_TIMESHEET,
			STAFFING_PERMISSIONS.READ_LABOR_POLICY,
		)
	const schedule =
		features.scheduling && can(STAFFING_PERMISSIONS.READ_SCHEDULE)
	const labor = features.labor && can(STAFFING_PERMISSIONS.READ_LABOR)
	const hiring = features.hiring && can(STAFFING_PERMISSIONS.READ_HIRING)
	return {
		visible: team || timeclock || schedule || labor || hiring,
		team,
		timeclock,
		schedule,
		labor,
		hiring,
	}
}

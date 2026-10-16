import { getUserId, getUserOrganizationPermissions } from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	and,
	db,
	eq,
	Organization,
	OrganizationLocation,
	UserOrganization,
	UserOrganizationLocation,
} from '@repo/database'
import {
	DEFAULT_PLATFORM_FEE_BP,
	expandImpliedGrants,
	foldReservationsFeatureState,
	isFlagOn,
	parsePlatformFeeBp,
	RESERVATIONS_FLAG_KEYS,
	RESERVATIONS_PERMISSION_LIST,
	RESERVATIONS_PLATFORM_FEE_BP_KEY,
	type ReservationsFeature,
	type ReservationsFeatureState,
	type ReservationsPermission,
} from '@repo/reservations'
import { ENV } from 'varlock/env'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	computeReservationsNavAccess,
	HIDDEN_RESERVATIONS_NAV,
	type ReservationsNavAccess,
} from '#app/utils/reservations/nav.ts'
import { postRegionalReservationsInternal } from '#app/utils/reservations/regional-internal.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

export {
	HIDDEN_RESERVATIONS_NAV,
	type ReservationsFeatureState,
	type ReservationsNavAccess,
}

const FEATURES = Object.keys(RESERVATIONS_FLAG_KEYS) as ReservationsFeature[]
const RESERVATIONS_PERMISSION_SET = new Set<string>(
	RESERVATIONS_PERMISSION_LIST,
)

/** Effective state of every reservations feature for an organization. */
export async function getReservationsFeatureState(
	organizationId: string,
): Promise<ReservationsFeatureState> {
	const values = await Promise.all(
		FEATURES.map((feature) =>
			getFeatureFlag(RESERVATIONS_FLAG_KEYS[feature], { organizationId }),
		),
	)
	const raw = Object.fromEntries(
		FEATURES.map((feature, i) => [feature, values[i]]),
	) as Partial<Record<ReservationsFeature, unknown>>
	return foldReservationsFeatureState(raw)
}

export async function getReservationsPlatformFeeBp(): Promise<number> {
	const raw = await getFeatureFlag(RESERVATIONS_PLATFORM_FEE_BP_KEY, {})
	return parsePlatformFeeBp(raw ?? DEFAULT_PLATFORM_FEE_BP)
}

export async function isReservationsFeatureEnabled(
	organizationId: string,
	feature: ReservationsFeature = 'enabled',
): Promise<boolean> {
	const master = await getFeatureFlag(RESERVATIONS_FLAG_KEYS.enabled, {
		organizationId,
	})
	if (!isFlagOn(master)) return false
	if (feature === 'enabled') return true
	const child = await getFeatureFlag(RESERVATIONS_FLAG_KEYS[feature], {
		organizationId,
	})
	return isFlagOn(child)
}

export async function requireReservationsFeature(
	organizationId: string,
	feature: ReservationsFeature = 'enabled',
): Promise<ReservationsFeatureState> {
	const state = await getReservationsFeatureState(organizationId)
	if (!state.enabled || !state[feature]) {
		throw new Response('Not Found', { status: 404 })
	}
	return state
}

export async function getUserReservationsGrants(
	userId: string,
	organizationId: string,
): Promise<ReservationsPermission[]> {
	const rows = await getUserOrganizationPermissions(userId, organizationId)
	const rawGrants: ReservationsPermission[] = []
	for (const row of rows) {
		const grant = `${row.action}:${row.entity}:${row.access}`
		if (RESERVATIONS_PERMISSION_SET.has(grant)) {
			rawGrants.push(grant as ReservationsPermission)
		}
	}
	return expandImpliedGrants(rawGrants)
}

/**
 * Location scoping for a member (`null` means every location; `[]` means no
 * locations allowed). Mirrors `resolveLocationGrantIds` in staffing.
 */
export async function resolveReservationsLocationIds(
	userId: string,
	organizationId: string,
): Promise<string[] | null> {
	const [membership] = await db
		.select({
			locationScope: UserOrganization.locationScope,
			active: UserOrganization.active,
		})
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!membership?.active) return []
	if (membership.locationScope === 'all') return null
	if (membership.locationScope !== 'selected') return []

	const rows = await db
		.select({ locationId: UserOrganizationLocation.locationId })
		.from(UserOrganizationLocation)
		.innerJoin(
			OrganizationLocation,
			and(
				eq(OrganizationLocation.id, UserOrganizationLocation.locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.where(
			and(
				eq(UserOrganizationLocation.userId, userId),
				eq(UserOrganizationLocation.organizationId, organizationId),
			),
		)
	return [...new Set(rows.map((r) => r.locationId))].sort()
}

export type ReservationsAccessOptions = {
	feature?: ReservationsFeature
	anyOf?: readonly ReservationsPermission[]
}

export type ReservationsAccessContext = {
	userId: string
	organizationId: string
	orgSlug: string
	organizationSlug: string
	dataRegion: 'us' | 'ksa'
	tenantApiUrl: string
	features: ReservationsFeatureState
	grants: ReservationsPermission[]
	locationIds: string[] | null
}

export async function requireReservationsAccess(
	request: Request,
	orgSlug: string | undefined,
	options: ReservationsAccessOptions = {},
): Promise<ReservationsAccessContext> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
	})
	const organizationId = organization.id
	const features = await requireReservationsFeature(
		organizationId,
		options.feature ?? 'enabled',
	)

	const userId = await getUserId(request)
	if (!userId) {
		throw new Response('Unauthorized', { status: 401 })
	}

	const [grants, locationIds] = await Promise.all([
		getUserReservationsGrants(userId, organizationId),
		resolveReservationsLocationIds(userId, organizationId),
	])

	if (options.anyOf && options.anyOf.length > 0) {
		const grantSet = new Set<string>(grants)
		const allowed = options.anyOf.some((perm) => grantSet.has(perm))
		if (!allowed) {
			throw new Response(`Forbidden: requires ${options.anyOf.join(' or ')}`, {
				status: 403,
			})
		}
	}

	if (locationIds !== null && locationIds.length === 0) {
		throw new Response('Forbidden: no reservation locations', { status: 403 })
	}

	const dataRegion = organization.dataRegion === 'ksa' ? 'ksa' : 'us'
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(dataRegion)

	return {
		userId,
		organizationId,
		orgSlug: organization.slug,
		organizationSlug: organization.slug,
		dataRegion,
		tenantApiUrl,
		features,
		grants,
		locationIds,
	}
}

export async function getReservationsNavAccess(
	userId: string,
	organizationId: string,
): Promise<ReservationsNavAccess> {
	const master = await getFeatureFlag(RESERVATIONS_FLAG_KEYS.enabled, {
		organizationId,
	})
	if (!isFlagOn(master)) return HIDDEN_RESERVATIONS_NAV

	const [features, grants, locationIds] = await Promise.all([
		getReservationsFeatureState(organizationId),
		getUserReservationsGrants(userId, organizationId),
		resolveReservationsLocationIds(userId, organizationId),
	])
	if (locationIds !== null && locationIds.length === 0) {
		return HIDDEN_RESERVATIONS_NAV
	}
	return computeReservationsNavAccess(features, grants)
}

/**
 * Best-effort notification to regional tenant-api when org-level reservations
 * context (flags, branding, locations, payment connection) changes.
 */
export async function notifyReservationsContextChanged(
	organizationId: string,
	reason?:
		| 'flags'
		| 'locations'
		| 'branding'
		| 'payments'
		| 'staffing'
		| 'voice'
		| 'manual',
): Promise<void> {
	try {
		const [org] = await db
			.select({
				dataRegion: Organization.dataRegion,
				hasProvisionedDb: Organization.hasProvisionedDb,
			})
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1)
		if (!org?.hasProvisionedDb) return
		const dataRegion = org.dataRegion === 'ksa' ? 'ksa' : 'us'
		const token = ENV.INTERNAL_COMMAND_TOKEN
		if (!token || token.length < 16) return
		await postRegionalReservationsInternal({
			dataRegion,
			path: 'context-changed',
			body: {
				orgId: organizationId,
				...(reason ? { reason } : {}),
			},
			timeoutMs: 5_000,
		})
	} catch {
		// Best-effort cache bust; regional cache also expires after 60s TTL.
	}
}

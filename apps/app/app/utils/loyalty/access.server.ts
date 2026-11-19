import {
	getUserId,
	getUserOrganizationPermissions,
	isImpersonating,
} from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	expandLoyaltyGrants,
	foldLoyaltyFeatures,
	isLoyaltyFlagOn,
	LOYALTY_FLAG_KEYS,
	LOYALTY_PERMISSION_LIST,
	type LoyaltyFeatures,
	type LoyaltyPermission,
} from '@repo/loyalty'
import { resolveMemberLocationIds } from '#app/utils/location/member-scope.server.ts'
import {
	computeLoyaltyCapabilities,
	type LoyaltyCapabilities,
	NO_LOYALTY_CAPABILITIES,
} from '#app/utils/loyalty/capabilities.ts'
import {
	computeLoyaltyNavAccess,
	HIDDEN_LOYALTY_NAV,
	type LoyaltyNavAccess,
} from '#app/utils/loyalty/nav.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

export { HIDDEN_LOYALTY_NAV, type LoyaltyNavAccess }

const LOYALTY_PERMISSION_SET = new Set<string>(LOYALTY_PERMISSION_LIST)

/** Effective state of every loyalty feature for an organization. */
export async function getLoyaltyFeatureState(
	organizationId: string,
): Promise<LoyaltyFeatures> {
	const keys = Object.keys(LOYALTY_FLAG_KEYS) as Array<
		keyof typeof LOYALTY_FLAG_KEYS
	>
	const values = await Promise.all(
		keys.map((name) =>
			getFeatureFlag(LOYALTY_FLAG_KEYS[name], { organizationId }),
		),
	)
	const raw: Partial<Record<keyof typeof LOYALTY_FLAG_KEYS, unknown>> = {}
	for (const [index, name] of keys.entries()) {
		raw[name] = values[index]
	}
	return foldLoyaltyFeatures(raw)
}

export async function isLoyaltyFeatureEnabled(
	organizationId: string,
): Promise<boolean> {
	const master = await getFeatureFlag(LOYALTY_FLAG_KEYS.enabled, {
		organizationId,
	})
	return isLoyaltyFlagOn(master)
}

export async function requireLoyaltyFeature(
	organizationId: string,
): Promise<LoyaltyFeatures> {
	const state = await getLoyaltyFeatureState(organizationId)
	if (!state.enabled) {
		throw new Response('Not Found', { status: 404 })
	}
	return state
}

export async function getUserLoyaltyGrants(
	userId: string,
	organizationId: string,
): Promise<LoyaltyPermission[]> {
	const rows = await getUserOrganizationPermissions(userId, organizationId)
	const rawGrants: LoyaltyPermission[] = []
	for (const row of rows) {
		const grant = `${row.action}:${row.entity}:${row.access}`
		if (LOYALTY_PERMISSION_SET.has(grant)) {
			rawGrants.push(grant as LoyaltyPermission)
		}
	}
	return expandLoyaltyGrants(rawGrants)
}

/**
 * Location scoping for a member (`null` means every location; `[]` means no
 * locations allowed). Mirrors `resolveReservationsLocationIds`.
 */
export async function resolveLoyaltyLocationIds(
	userId: string,
	organizationId: string,
): Promise<string[] | null> {
	return resolveMemberLocationIds(userId, organizationId)
}

export type LoyaltyAccessOptions = {
	anyOf?: readonly LoyaltyPermission[]
}

export type LoyaltyAccessContext = {
	userId: string
	organizationId: string
	orgSlug: string
	dataRegion: 'us' | 'ksa'
	tenantApiUrl: string
	features: LoyaltyFeatures
	grants: LoyaltyPermission[]
	locationIds: string[] | null
}

export async function requireLoyaltyAccess(
	request: Request,
	orgSlug: string | undefined,
	options: LoyaltyAccessOptions = {},
): Promise<LoyaltyAccessContext> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
	})
	const organizationId = organization.id
	const features = await requireLoyaltyFeature(organizationId)

	const userId = await getUserId(request)
	if (!userId) {
		throw new Response('Unauthorized', { status: 401 })
	}

	const [grants, locationIds] = await Promise.all([
		getUserLoyaltyGrants(userId, organizationId),
		resolveLoyaltyLocationIds(userId, organizationId),
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
		throw new Response('Forbidden: no loyalty locations', { status: 403 })
	}

	const dataRegion = organization.dataRegion === 'ksa' ? 'ksa' : 'us'
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(dataRegion)

	return {
		userId,
		organizationId,
		orgSlug: organization.slug,
		dataRegion,
		tenantApiUrl,
		features,
		grants,
		locationIds,
	}
}

export async function getLoyaltyNavAccess(
	userId: string,
	organizationId: string,
): Promise<LoyaltyNavAccess> {
	const features = await getLoyaltyFeatureState(organizationId)
	if (!features.enabled) return HIDDEN_LOYALTY_NAV

	const [grants, locationIds] = await Promise.all([
		getUserLoyaltyGrants(userId, organizationId),
		resolveLoyaltyLocationIds(userId, organizationId),
	])
	if (locationIds !== null && locationIds.length === 0) {
		return HIDDEN_LOYALTY_NAV
	}
	return computeLoyaltyNavAccess(features, grants)
}

/**
 * What the signed-in user may do with a customer's points account, for the
 * Customer profile. Never throws for a missing flag or grant (the profile
 * stays reachable); the regional token mint enforces every grant again.
 */
export async function getLoyaltyCapabilities(
	request: Request,
	organizationId: string,
): Promise<LoyaltyCapabilities> {
	const features = await getLoyaltyFeatureState(organizationId)
	if (!features.enabled) return NO_LOYALTY_CAPABILITIES
	const userId = await getUserId(request)
	if (!userId) return NO_LOYALTY_CAPABILITIES

	const [grants, locationIds, impersonated] = await Promise.all([
		getUserLoyaltyGrants(userId, organizationId),
		resolveLoyaltyLocationIds(userId, organizationId),
		isImpersonating(request),
	])
	return computeLoyaltyCapabilities({
		features,
		grants,
		locationIds,
		impersonated,
	})
}

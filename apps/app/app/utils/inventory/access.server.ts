import {
	getUserId,
	getUserOrganizationPermissions,
	isImpersonating,
	ORG_PERMISSIONS,
} from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { and, db, eq, Organization, UserOrganization } from '@repo/database'
import {
	expandInventoryGrants,
	foldInventoryFeatures,
	INVENTORY_FLAG_KEYS,
	INVENTORY_PERMISSIONS,
	type InventoryFeatures,
	type InventoryFlagName,
	type InventoryPermission,
	isInventoryFlagOn,
	isInventoryPermission,
} from '@repo/inventory'
import { resolveDiscountLocationIds } from '#app/utils/discounts/location-scope.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	computeInventoryNavAccess,
	HIDDEN_INVENTORY_NAV,
	type InventoryNavAccess,
} from './nav.ts'

/**
 * Inventory access: the org's `inventory.enabled` flag (default off) and
 * `read:inventory:any`. A disabled organization gets a 404 before any
 * permission is checked. Stock, counts and suppliers live in the regional
 * tenant database; the App only checks flags and grants and mints the
 * browser-direct token.
 */

export { HIDDEN_INVENTORY_NAV, type InventoryNavAccess }

const FLAG_NAMES = Object.keys(INVENTORY_FLAG_KEYS) as InventoryFlagName[]

/** Effective state of every inventory feature for an organization. */
export async function getInventoryFeatureState(
	organizationId: string,
): Promise<InventoryFeatures> {
	const values = await Promise.all(
		FLAG_NAMES.map((name) =>
			getFeatureFlag(INVENTORY_FLAG_KEYS[name], { organizationId }),
		),
	)
	const raw: Partial<Record<InventoryFlagName, unknown>> = {}
	FLAG_NAMES.forEach((name, index) => {
		raw[name] = values[index]
	})
	return foldInventoryFeatures(raw)
}

/** The member's inventory grants, with the reads each one implies. */
export async function getUserInventoryGrants(
	userId: string,
	organizationId: string,
): Promise<InventoryPermission[]> {
	const rows = await getUserOrganizationPermissions(userId, organizationId)
	const held: string[] = []
	for (const row of rows) {
		const grant = `${row.action}:${row.entity}:${row.access}`
		if (isInventoryPermission(grant)) held.push(grant)
	}
	return expandInventoryGrants(held)
}

export type InventoryAccessOptions = {
	/** The member needs at least one of these (default `read:inventory:any`). */
	anyOf?: readonly InventoryPermission[]
	/** The member needs every one of these. */
	requireAll?: readonly InventoryPermission[]
}

export type InventoryAccess = {
	organizationId: string
	organizationSlug: string
	organizationName: string
	userId: string
	features: InventoryFeatures
	grants: InventoryPermission[]
	/** `null` = every location; never `[]` (that answers 403). */
	locationIds: string[] | null
	dataRegion: 'us' | 'ksa'
	/** Money figures are shown in the data region's currency. */
	currency: 'USD' | 'SAR'
	impersonated: boolean
	/** Member holds `update:settings:any` (and is not impersonated). */
	canManageSettings: boolean
	/** Member's org role is `org_role_admin` (owner; and is not impersonated). */
	isOwner: boolean
}

type AccessOrganization = {
	id: string
	slug: string
	name: string
	dataRegion: string | null
}

/**
 * The shared half of access: flags, grants, location scope and the manager
 * facts of one member in one organization. Cookie sessions
 * (`requireInventoryAccess`) and the phone app's bearer login
 * (`requireInventoryAccessForUser`) both end here, so a screen on the web and
 * on the phone check the same rules.
 */
async function resolveInventoryAccess(input: {
	userId: string
	organization: AccessOrganization
	impersonated: boolean
	options: InventoryAccessOptions
}): Promise<InventoryAccess> {
	const { userId, organization, impersonated, options } = input
	const features = await getInventoryFeatureState(organization.id)
	if (!features.enabled) throw new Response('Not Found', { status: 404 })

	const [rawPerms, locationIds, membership] = await Promise.all([
		getUserOrganizationPermissions(userId, organization.id),
		resolveDiscountLocationIds(userId, organization.id),
		db.query.UserOrganization.findFirst({
			where: and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, organization.id),
			),
			columns: { organizationRoleId: true },
		}),
	])
	const heldRaw: string[] = []
	let hasManageSettings = false
	for (const row of rawPerms) {
		const perm = `${row.action}:${row.entity}:${row.access}`
		if (perm === ORG_PERMISSIONS.UPDATE_SETTINGS_ANY) {
			hasManageSettings = true
		}
		if (isInventoryPermission(perm)) heldRaw.push(perm)
	}
	const grants = expandInventoryGrants(heldRaw)

	const held = new Set<string>(grants)
	const anyOf =
		options.anyOf && options.anyOf.length > 0
			? options.anyOf
			: [INVENTORY_PERMISSIONS.READ_INVENTORY]
	if (!anyOf.some((perm) => held.has(perm))) {
		throw new Response(`Forbidden: requires ${anyOf.join(' or ')}`, {
			status: 403,
		})
	}
	const missing = (options.requireAll ?? []).filter((perm) => !held.has(perm))
	if (missing.length > 0) {
		throw new Response(`Forbidden: requires ${missing.join(' and ')}`, {
			status: 403,
		})
	}
	if (locationIds !== null && locationIds.length === 0) {
		throw new Response('Forbidden: no inventory locations', { status: 403 })
	}

	const dataRegion = organization.dataRegion === 'ksa' ? 'ksa' : 'us'
	return {
		organizationId: organization.id,
		organizationSlug: organization.slug,
		organizationName: organization.name,
		userId,
		features,
		grants,
		locationIds,
		dataRegion,
		currency: dataRegion === 'ksa' ? 'SAR' : 'USD',
		impersonated,
		canManageSettings: !impersonated && hasManageSettings,
		isOwner:
			!impersonated && membership?.organizationRoleId === 'org_role_admin',
	}
}

/**
 * Every inventory loader and action awaits this first.
 */
export async function requireInventoryAccess(
	request: Request,
	orgSlug: string | undefined,
	options: InventoryAccessOptions = {},
): Promise<InventoryAccess> {
	const organization = (await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		name: true,
		dataRegion: true,
	})) as AccessOrganization
	// A disabled organization gets a 404 before any permission is checked.
	if (!(await getInventoryFeatureState(organization.id)).enabled) {
		throw new Response('Not Found', { status: 404 })
	}

	const userId = await getUserId(request)
	if (!userId) throw new Response('Unauthorized', { status: 401 })
	return resolveInventoryAccess({
		userId,
		organization,
		impersonated: await isImpersonating(request),
		options,
	})
}

/**
 * The phone app's version (`/api/inventory/token`): the member is already known
 * from the bearer login, the organization is named by id. Not a member, an
 * inactive organization and a disabled module all answer 404, so nothing leaks
 * about organizations the member is not in. A phone is never an impersonation.
 */
export async function requireInventoryAccessForUser(
	userId: string,
	organizationId: string,
	options: InventoryAccessOptions = {},
): Promise<InventoryAccess> {
	const [row] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			name: Organization.name,
			dataRegion: Organization.dataRegion,
		})
		.from(Organization)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Organization.id),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.where(
			and(eq(Organization.id, organizationId), eq(Organization.active, true)),
		)
		.limit(1)
	if (!row) throw new Response('Not Found', { status: 404 })
	return resolveInventoryAccess({
		userId,
		organization: row,
		impersonated: false,
		options,
	})
}

/** Sidebar access; never throws for a missing flag or grant. */
export async function getInventoryNavAccess(
	userId: string,
	organizationId: string,
): Promise<InventoryNavAccess> {
	const features = await getInventoryFeatureState(organizationId)
	if (!features.enabled) return HIDDEN_INVENTORY_NAV
	const [grants, locationIds] = await Promise.all([
		getUserInventoryGrants(userId, organizationId),
		resolveDiscountLocationIds(userId, organizationId),
	])
	if (locationIds !== null && locationIds.length === 0) {
		return HIDDEN_INVENTORY_NAV
	}
	return computeInventoryNavAccess(features, grants)
}

/** Whether the master flag is on (for the role editor's Inventory group). */
export async function isInventoryFeatureEnabled(
	organizationId: string,
): Promise<boolean> {
	const master = await getFeatureFlag(INVENTORY_FLAG_KEYS.enabled, {
		organizationId,
	})
	return isInventoryFlagOn(master)
}

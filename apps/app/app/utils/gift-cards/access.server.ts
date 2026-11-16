import {
	getUserId,
	getUserOrganizationPermissions,
	isImpersonating,
} from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	expandGiftCardGrants,
	foldGiftCardFeatures,
	GIFT_CARD_FLAG_KEYS,
	GIFT_CARD_PERMISSIONS,
	isGiftCardPermission,
	type GiftCardFeatures,
	type GiftCardFlagName,
	type GiftCardPermission,
} from '@repo/common/gift-cards'
import { db, eq, User } from '@repo/database'
import { resolveDiscountLocationIds } from '#app/utils/discounts/location-scope.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	computeGiftCardNavAccess,
	HIDDEN_GIFT_CARD_NAV,
	type GiftCardNavAccess,
} from './nav.ts'

/**
 * Gift card access: the organization's `gift_cards.enabled` flag (default off)
 * and a gift card grant. A disabled organization gets a 404 before any
 * permission is checked. Codes, balances and purchaser or recipient details
 * live in the regional tenant database; the App only checks flags and grants,
 * keeps the settings, and mints the browser-direct token.
 */

export { HIDDEN_GIFT_CARD_NAV, type GiftCardNavAccess }

const FLAG_NAMES = Object.keys(GIFT_CARD_FLAG_KEYS) as GiftCardFlagName[]

/** Effective state of every gift card feature for an organization. */
export async function getGiftCardFeatureState(
	organizationId: string,
): Promise<GiftCardFeatures> {
	const values = await Promise.all(
		FLAG_NAMES.map((name) =>
			getFeatureFlag(GIFT_CARD_FLAG_KEYS[name], { organizationId }),
		),
	)
	const raw: Partial<Record<GiftCardFlagName, unknown>> = {}
	FLAG_NAMES.forEach((name, index) => {
		raw[name] = values[index]
	})
	return foldGiftCardFeatures(raw)
}

/** The member's gift card grants, with the reads each one implies. */
export async function getUserGiftCardGrants(
	userId: string,
	organizationId: string,
): Promise<GiftCardPermission[]> {
	const rows = await getUserOrganizationPermissions(userId, organizationId)
	const held: string[] = []
	for (const row of rows) {
		const grant = `${row.action}:${row.entity}:${row.access}`
		if (isGiftCardPermission(grant)) held.push(grant)
	}
	return expandGiftCardGrants(held)
}

export type GiftCardAccessOptions = {
	/** The member needs at least one of these (default `read:gift_card:any`). */
	anyOf?: readonly GiftCardPermission[]
	/** The member needs every one of these. */
	requireAll?: readonly GiftCardPermission[]
}

export type GiftCardAccess = {
	organizationId: string
	organizationSlug: string
	organizationName: string
	userId: string
	/** The named operator kept on adjustments and charges. */
	userName: string
	features: GiftCardFeatures
	grants: GiftCardPermission[]
	/** `null` = every location; never `[]` (that answers 403). */
	locationIds: string[] | null
	dataRegion: 'us' | 'ksa'
	currency: 'USD' | 'SAR'
	impersonated: boolean
}

/** Every gift card loader and action awaits this first. */
export async function requireGiftCardAccess(
	request: Request,
	orgSlug: string | undefined,
	options: GiftCardAccessOptions = {},
): Promise<GiftCardAccess> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		name: true,
		dataRegion: true,
	})
	const features = await getGiftCardFeatureState(organization.id)
	if (!features.enabled) throw new Response('Not Found', { status: 404 })

	const userId = await getUserId(request)
	if (!userId) throw new Response('Unauthorized', { status: 401 })

	const [grants, locationIds, impersonated, user] = await Promise.all([
		getUserGiftCardGrants(userId, organization.id),
		resolveDiscountLocationIds(userId, organization.id),
		isImpersonating(request),
		db.select({ name: User.name }).from(User).where(eq(User.id, userId)).get(),
	])

	const held = new Set<string>(grants)
	const anyOf =
		options.anyOf && options.anyOf.length > 0
			? options.anyOf
			: [GIFT_CARD_PERMISSIONS.READ_GIFT_CARD]
	if (!anyOf.some((permission) => held.has(permission))) {
		throw new Response(`Forbidden: requires ${anyOf.join(' or ')}`, {
			status: 403,
		})
	}
	const missing = (options.requireAll ?? []).filter(
		(permission) => !held.has(permission),
	)
	if (missing.length > 0) {
		throw new Response(`Forbidden: requires ${missing.join(' and ')}`, {
			status: 403,
		})
	}
	if (locationIds !== null && locationIds.length === 0) {
		throw new Response('Forbidden: no gift card locations', { status: 403 })
	}

	const dataRegion = organization.dataRegion === 'ksa' ? 'ksa' : 'us'
	return {
		organizationId: organization.id,
		organizationSlug: organization.slug,
		organizationName: organization.name,
		userId,
		userName: user?.name?.trim() || 'Staff member',
		features,
		grants,
		locationIds,
		dataRegion,
		currency: dataRegion === 'ksa' ? 'SAR' : 'USD',
		impersonated,
	}
}

/** Sidebar access; never throws for a missing flag or grant. */
export async function getGiftCardNavAccess(
	userId: string,
	organizationId: string,
): Promise<GiftCardNavAccess> {
	const features = await getGiftCardFeatureState(organizationId)
	if (!features.enabled) return HIDDEN_GIFT_CARD_NAV
	const [grants, locationIds] = await Promise.all([
		getUserGiftCardGrants(userId, organizationId),
		resolveDiscountLocationIds(userId, organizationId),
	])
	if (locationIds !== null && locationIds.length === 0) {
		return HIDDEN_GIFT_CARD_NAV
	}
	return computeGiftCardNavAccess(features, grants)
}

/** Whether the master flag is on (for the role editor's Gift cards group). */
export async function isGiftCardFeatureEnabled(
	organizationId: string,
): Promise<boolean> {
	return (await getGiftCardFeatureState(organizationId)).enabled
}

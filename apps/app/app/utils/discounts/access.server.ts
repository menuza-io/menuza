import { userHasOrganizationPermission } from '@repo/auth'
import {
	DISCOUNTS_FLAG_KEYS,
	type DiscountsFeatures,
	foldDiscountsFeatures,
} from '@repo/common/discounts-flags'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	checkRateLimit,
	MENU_MUTATION_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { resolveDiscountLocationIds } from './location-scope.server.ts'
import { HIDDEN_DISCOUNTS_NAV, type DiscountsNavAccess } from './nav.ts'

/**
 * Discounts access: `read:discount:any` to view, `update:discount:any` to
 * change, behind the org's `discounts.enabled` flag (default off). A disabled
 * organization gets a 404 before any permission is checked.
 */

export { HIDDEN_DISCOUNTS_NAV, type DiscountsNavAccess }

export async function getDiscountsFeatures(
	organizationId: string,
): Promise<DiscountsFeatures> {
	const [enabled, automatic, coupons] = await Promise.all([
		getFeatureFlag(DISCOUNTS_FLAG_KEYS.enabled, { organizationId }),
		getFeatureFlag(DISCOUNTS_FLAG_KEYS.automatic, { organizationId }),
		getFeatureFlag(DISCOUNTS_FLAG_KEYS.coupons, { organizationId }),
	])
	return foldDiscountsFeatures({ enabled, automatic, coupons })
}

export async function getDiscountsNavAccess(
	userId: string,
	organizationId: string,
): Promise<DiscountsNavAccess> {
	const features = await getDiscountsFeatures(organizationId)
	if (!features.enabled) return HIDDEN_DISCOUNTS_NAV
	const canRead = await userHasOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.READ_DISCOUNT_ANY,
	)
	return { visible: canRead }
}

export type DiscountsAccess = {
	userId: string
	organization: { id: string; slug: string; dataRegion: string | null }
	features: DiscountsFeatures
	canWrite: boolean
	/**
	 * Fallback currency for amounts when no location says one (the data region
	 * decides it). A discount's amounts follow the currency of the locations it
	 * applies to: see `resolveDiscountCurrency`.
	 */
	currency: 'USD' | 'SAR'
	/** `null` = every location; `[]` = none (see `resolveDiscountLocationIds`). */
	locationIds: string[] | null
}

/**
 * Every discounts loader and action awaits this first. Reads need
 * `read:discount:any`; `write: true` needs `update:discount:any` and takes a
 * share of the menu mutation rate limit.
 */
export async function requireDiscountsAccess(
	request: Request,
	orgSlug: string | undefined,
	options: { write?: boolean } = {},
): Promise<DiscountsAccess> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
	})
	const features = await getDiscountsFeatures(organization.id)
	if (!features.enabled) throw new Response('Not Found', { status: 404 })

	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		options.write
			? ORG_PERMISSIONS.UPDATE_DISCOUNT_ANY
			: ORG_PERMISSIONS.READ_DISCOUNT_ANY,
	)
	if (options.write) {
		const { allowed, resetAt } = await checkRateLimit(
			{ type: 'user', value: userId },
			MENU_MUTATION_RATE_LIMIT,
		)
		if (!allowed) {
			const retryAfter = Math.max(
				0,
				Math.ceil((resetAt.getTime() - Date.now()) / 1000),
			)
			throw new Response('Too many changes. Please try again shortly.', {
				status: 429,
				headers: {
					'Retry-After': retryAfter.toString(),
					'X-RateLimit-Reset': resetAt.toISOString(),
				},
			})
		}
	}
	const [canWrite, locationIds] = await Promise.all([
		options.write
			? Promise.resolve(true)
			: userHasOrganizationPermission(
					userId,
					organization.id,
					ORG_PERMISSIONS.UPDATE_DISCOUNT_ANY,
				),
		resolveDiscountLocationIds(userId, organization.id),
	])
	return {
		userId,
		organization,
		features,
		canWrite,
		currency: organization.dataRegion === 'ksa' ? 'SAR' : 'USD',
		locationIds,
	}
}

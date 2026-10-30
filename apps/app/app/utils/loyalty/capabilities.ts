import {
	hasLoyaltyGrant,
	LOYALTY_PERMISSIONS as P,
	type LoyaltyFeatures,
	type LoyaltyPermission,
} from '@repo/loyalty'

/**
 * What the signed-in operator may do with a customer's points account. These
 * flags only decide what the Customer profile shows; the regional token and
 * the regional API enforce every grant again.
 */
export type LoyaltyCapabilities = {
	/** The organization has Loyalty turned on. */
	enabled: boolean
	/** `read:loyalty:any`: the Loyalty panel shows. */
	canRead: boolean
	/** `update:loyalty_points:any`: adjust points, suspend, reactivate. */
	canAdjust: boolean
	/** `update:loyalty_redemption:any`: record a refund. */
	canReconcile: boolean
}

export const NO_LOYALTY_CAPABILITIES: LoyaltyCapabilities = {
	enabled: false,
	canRead: false,
	canAdjust: false,
	canReconcile: false,
}

export function computeLoyaltyCapabilities({
	features,
	grants,
	locationIds,
	impersonated,
}: {
	features: LoyaltyFeatures
	grants: readonly LoyaltyPermission[]
	/** `null`: every location; `[]`: no location at all. */
	locationIds: readonly string[] | null
	impersonated: boolean
}): LoyaltyCapabilities {
	if (!features.enabled) return NO_LOYALTY_CAPABILITIES
	if (locationIds !== null && locationIds.length === 0) {
		return { ...NO_LOYALTY_CAPABILITIES, enabled: true }
	}
	const canRead = hasLoyaltyGrant(grants, P.READ_LOYALTY)
	return {
		enabled: true,
		canRead,
		// Support impersonation looks but never changes anything.
		canAdjust:
			canRead &&
			!impersonated &&
			hasLoyaltyGrant(grants, P.UPDATE_LOYALTY_POINTS),
		canReconcile:
			canRead &&
			!impersonated &&
			hasLoyaltyGrant(grants, P.UPDATE_LOYALTY_REDEMPTION),
	}
}

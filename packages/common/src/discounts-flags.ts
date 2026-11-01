/**
 * Discounts and coupons feature flags (control plane `ConfigFlag`, default off,
 * only a literal `true` counts). Shared by App (access, nav, order context) and
 * read by the regional node through the folded `discounts.features` field of the
 * order context.
 */

export const DISCOUNTS_FLAG_KEYS = {
	enabled: 'discounts.enabled',
	automatic: 'discounts.automatic',
	coupons: 'discounts.coupons',
} as const

export type DiscountsFlagName = keyof typeof DISCOUNTS_FLAG_KEYS
export type DiscountsFlagKey = (typeof DISCOUNTS_FLAG_KEYS)[DiscountsFlagName]

export type DiscountsFeatures = {
	enabled: boolean
	automatic: boolean
	coupons: boolean
}

/**
 * Folds raw flag values into features. Only a literal `true` counts, and the
 * two sub-flags are off whenever the master is not on.
 */
export function foldDiscountsFeatures(raw: {
	enabled: unknown
	automatic: unknown
	coupons: unknown
}): DiscountsFeatures {
	const enabled = raw.enabled === true
	return {
		enabled,
		automatic: enabled && raw.automatic === true,
		coupons: enabled && raw.coupons === true,
	}
}

import { z } from 'zod'

/**
 * ConfigFlag keys for Loyalty. Every flag defaults to off and is turned on per
 * organization. Only a literal boolean `true` counts as on. `loyalty.enabled`
 * is the master flag: the child flags read as off whenever it is not on.
 */
export const LOYALTY_FLAG_KEYS = {
	enabled: 'loyalty.enabled',
	redemption: 'loyalty.redemption',
} as const

export type LoyaltyFlagName = keyof typeof LOYALTY_FLAG_KEYS
export type LoyaltyFlagKey = (typeof LOYALTY_FLAG_KEYS)[LoyaltyFlagName]

export const LOYALTY_FLAG_KEY_LIST: readonly LoyaltyFlagKey[] =
	Object.values(LOYALTY_FLAG_KEYS)

export type LoyaltyFeatures = {
	/** Enrollment, wallets, earning and the operator screens. */
	enabled: boolean
	/** Spending points on rewards: quotes, holds and member codes. */
	redemption: boolean
}

export const LOYALTY_FEATURES_OFF: Readonly<LoyaltyFeatures> = Object.freeze({
	enabled: false,
	redemption: false,
})

export const loyaltyFeaturesSchema = z
	.object({
		enabled: z.boolean(),
		redemption: z.boolean(),
	})
	.strict()

export function isLoyaltyFlagOn(value: unknown): boolean {
	return value === true
}

/**
 * Fold raw flag values, keyed by short name, into features. Children are forced
 * off whenever the master flag is not on.
 */
export function foldLoyaltyFeatures(
	raw: Partial<Record<LoyaltyFlagName, unknown>>,
): LoyaltyFeatures {
	const enabled = isLoyaltyFlagOn(raw.enabled)
	return {
		enabled,
		redemption: enabled && isLoyaltyFlagOn(raw.redemption),
	}
}

/**
 * Read features from an untrusted payload such as a context response or a
 * token claim. Anything missing or malformed reads as all off.
 */
export function readLoyaltyFeatures(raw: unknown): LoyaltyFeatures {
	const parsed = loyaltyFeaturesSchema.safeParse(raw)
	if (!parsed.success) return { ...LOYALTY_FEATURES_OFF }
	return foldLoyaltyFeatures(parsed.data)
}

/**
 * What the US App tells a region about an organization
 * (`GET /resources/loyalty/context?orgId=`): its flags, nothing else. Unknown
 * fields are dropped so the App can add some before the regions read them.
 */
export const loyaltyContextSchema = z.object({
	orgId: z.string().min(1).max(64),
	features: loyaltyFeaturesSchema,
})
export type LoyaltyContext = z.infer<typeof loyaltyContextSchema>

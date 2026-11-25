/**
 * Alcohol rules for online orders (#167). One setting per location says where
 * alcohol may be ordered online; one pure check applies it. `priceRestaurantOrder`
 * is the only caller that refuses a cart, so the website, QR tables, the phone
 * agent and the API all answer the same way.
 *
 * Pure: no I/O, no guest data. The age confirmation is a yes on the order and
 * is never a birth date.
 */

export const ALCOHOL_ONLINE_VALUES = [
	'pickup_and_delivery',
	'pickup',
	'delivery',
	'none',
] as const
export type AlcoholOnline = (typeof ALCOHOL_ONLINE_VALUES)[number]

/** What an existing location does until its owner reviews the setting. */
export const DEFAULT_ALCOHOL_ONLINE: AlcoholOnline = 'pickup_and_delivery'

export const ALCOHOL_NOT_ALLOWED_CODE = 'alcohol_not_allowed'
export const AGE_CONFIRMATION_REQUIRED_CODE = 'age_confirmation_required'
/** The wording on the checkout box. The minimum age is the US drinking age. */
export const ALCOHOL_MINIMUM_AGE = 21

export type AlcoholFulfillment = 'pickup' | 'delivery' | 'dine_in'

/** A stored value, or null when the location has not been reviewed (or the value is unknown). */
export function readAlcoholOnline(value: unknown): AlcoholOnline | null {
	return typeof value === 'string' &&
		(ALCOHOL_ONLINE_VALUES as readonly string[]).includes(value)
		? (value as AlcoholOnline)
		: null
}

/**
 * The rule that applies: a KSA location refuses alcohol online whatever was
 * stored (its settings are hidden there); an unreviewed location keeps what
 * happened before the setting existed.
 */
export function effectiveAlcoholOnline(
	value: unknown,
	options: { ksa?: boolean } = {},
): AlcoholOnline {
	if (options.ksa) return 'none'
	return readAlcoholOnline(value) ?? DEFAULT_ALCOHOL_ONLINE
}

/**
 * Whether a cart with alcohol may be placed as this order type. Courier
 * delivery (a zone served by a delivery app) never carries alcohol, whatever
 * the setting. A table round is served and checked by the team, so only
 * "not online" refuses it.
 */
export function alcoholAllowedFor(
	setting: AlcoholOnline,
	fulfillment: AlcoholFulfillment,
	options: { courier?: boolean } = {},
): boolean {
	if (setting === 'none') return false
	if (fulfillment === 'delivery') {
		if (options.courier) return false
		return setting === 'pickup_and_delivery' || setting === 'delivery'
	}
	if (fulfillment === 'pickup') {
		return setting === 'pickup_and_delivery' || setting === 'pickup'
	}
	return true
}

/** The context the App sends with the menu: one setting per location id. */
export type AlcoholContext = {
	/** The organization's data region is KSA: alcohol is refused online. */
	ksa?: boolean
	locations?: Record<string, unknown>
}

export function readAlcoholContext(
	context: unknown,
	locationId: string,
	currency?: string,
): AlcoholOnline {
	const value =
		context && typeof context === 'object'
			? (context as AlcoholContext)
			: ({} as AlcoholContext)
	const stored = value.locations?.[locationId]
	return effectiveAlcoholOnline(stored, {
		ksa: value.ksa === true || currency === 'SAR',
	})
}

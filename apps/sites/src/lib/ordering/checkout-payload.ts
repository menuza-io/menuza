/** The order a checkout prices for a reward quote, before contact and notes. */
export type PricedOrder = Record<string, unknown> & {
	delivery?: Record<string, string>
}

/**
 * The order to place, built in one go from the order the reward was priced
 * against: placing it can then never send a cart, tip or address the quote
 * did not see.
 */
export function checkoutOrderPayload(
	priced: PricedOrder,
	extra: {
		contact: { name: string; phone: string; email: string }
		deliveryNotes?: string
		reward: unknown
		/** `{code?, expectedDiscountMinor}` from the confirmed discount quote; null sends none. */
		discounts?: Record<string, unknown> | null
	},
): Record<string, unknown> {
	const notes = extra.deliveryNotes?.trim()
	return {
		...priced,
		contact: extra.contact,
		...(priced.delivery && notes
			? { delivery: { ...priced.delivery, notes } }
			: {}),
		...(extra.reward ? { loyalty: extra.reward } : {}),
		...(extra.discounts ? { discounts: extra.discounts } : {}),
	}
}

/**
 * The request body: the core payload, the attempt key and the boxes the
 * signed-in guest ticked (undefined sends none). The attempt key is derived
 * from `core` alone, so consent is added only here, after the key exists:
 * changing a box on a retry must replay the first order, not place a second.
 */
export function checkoutOrderRequest(
	core: Record<string, unknown>,
	idempotencyKey: string,
	marketingConsent?: Record<string, unknown> | null,
): Record<string, unknown> {
	return {
		...core,
		...(marketingConsent ? { marketingConsent } : {}),
		idempotencyKey,
	}
}

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
		/**
		 * "Text me order updates": whether the region offered the box and the
		 * guest ticked it. Transactional, never marketing consent.
		 */
		smsUpdates?: { offered: boolean; ticked: boolean }
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
		...(wantsSmsUpdates(priced, extra) ? { smsUpdates: true } : {}),
	}
}

/**
 * `true` only when the box was offered, ticked and a phone was typed, and the
 * order is not a table (dine-in) round; otherwise the key is left out.
 */
function wantsSmsUpdates(
	priced: PricedOrder,
	extra: {
		contact: { phone: string }
		smsUpdates?: { offered: boolean; ticked: boolean }
	},
): boolean {
	const choice = extra.smsUpdates
	return Boolean(
		choice?.offered &&
		choice.ticked &&
		extra.contact.phone.trim() !== '' &&
		priced.fulfillment !== 'dine_in',
	)
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

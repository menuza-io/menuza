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
	}
}

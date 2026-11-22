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
		/**
		 * The service fee (#123) the page showed, minor units. Sent only when
		 * there is one: a missing value reads as 0 at the region, which refuses a
		 * different fee with 409 `service_fee_changed`.
		 */
		expectedServiceFeeMinor?: number
		/**
		 * The packaging fee (#408) the page showed, minor units, sent only when
		 * there is one (a missing value reads as 0 at the region, which refuses a
		 * different fee with 409 `packaging_fee_changed`).
		 */
		expectedPackagingFeeMinor?: number
		/**
		 * The utensils and napkins checkbox (#257): `null` when the question was
		 * not shown (the key is left out and the region ignores it anyway), else
		 * what the guest chose.
		 */
		utensilsRequested?: boolean | null
		/** A gift card applied after discounts and loyalty (#110): `{code | savedCardId, expectedAmountMinor}`. */
		giftCard?: Record<string, unknown> | null
		/**
		 * A browser id for referral abuse checks; sent only when a referral
		 * code is the discount code of this order.
		 */
		referralDeviceId?: string | null
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
		...(extra.giftCard ? { giftCard: extra.giftCard } : {}),
		...(extra.referralDeviceId &&
		typeof extra.discounts?.code === 'string' &&
		extra.discounts.code.toUpperCase().startsWith('REF')
			? { referralDeviceId: extra.referralDeviceId }
			: {}),
		...(wantsSmsUpdates(priced, extra) ? { smsUpdates: true } : {}),
		...(extra.expectedServiceFeeMinor && extra.expectedServiceFeeMinor > 0
			? { expectedServiceFeeMinor: extra.expectedServiceFeeMinor }
			: {}),
		...(extra.expectedPackagingFeeMinor && extra.expectedPackagingFeeMinor > 0
			? { expectedPackagingFeeMinor: extra.expectedPackagingFeeMinor }
			: {}),
		// Only an order the box was shown for (pickup or delivery, never a table).
		...(typeof extra.utensilsRequested === 'boolean' &&
		priced.fulfillment !== 'dine_in'
			? { utensilsRequested: extra.utensilsRequested }
			: {}),
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
 * The same goes for the attribution (#115): the first order keeps its own.
 */
export function checkoutOrderRequest(
	core: Record<string, unknown>,
	idempotencyKey: string,
	marketingConsent?: Record<string, unknown> | null,
	/** Where the guest came from (#115), added after the key like consent. */
	attribution?: Record<string, unknown> | null,
	/**
	 * The dish photo tests (#192) this cart's dishes were in, with the photo
	 * this browser showed. Sent only when there is at least one (the region's
	 * body is strict), and, like the attribution, only after the key exists.
	 */
	photoTests?: ReadonlyArray<{
		testId: string
		itemId: string
		variant: 'A' | 'B'
		key: string
	}> | null,
): Record<string, unknown> {
	return {
		...core,
		...(marketingConsent ? { marketingConsent } : {}),
		...(attribution ? { attribution } : {}),
		...(photoTests && photoTests.length > 0
			? { photoTests: photoTests.map((entry) => ({ ...entry })) }
			: {}),
		idempotencyKey,
	}
}

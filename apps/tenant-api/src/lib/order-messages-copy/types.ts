import { type OrderMessageKind } from '@repo/tenant-db'

/**
 * Shipped copy for one guest order message. Placeholders are `{name}` style:
 * `{number}` (order number), `{r}` (restaurant), `{location}`. Operators never
 * author these. Subjects never name an address or a phone number.
 */
export type OrderKindCopy = {
	subject: string
	heading: string
	lead: string
	/** The same lead for a delivery order, when it reads differently. */
	leadDelivery?: string
}

export type OrderCopyLabels = {
	order: string
	location: string
	items: string
	subtotal: string
	discount: string
	reward: string
	deliveryFee: string
	tip: string
	serviceFee: string
	/** The packaging or bag fee line (#408). */
	packagingFee: string
	/** Where to go for a pickup order (#251), shown above the text the restaurant wrote. */
	pickupInstructions: string
	/** The utensils and napkins answer (#257) and its two values. */
	utensils: string
	utensilsYes: string
	utensilsNo: string
	tax: string
	total: string
	refunded: string
	/** A cancelled order whose provider refund is still on its way. */
	refundPending: string
	/** Why it was cancelled (guest-visible reasons only). */
	reason: string
	reasonOutOfStock: string
	reasonKitchenClosed: string
	pickupTime: string
	deliveryTime: string
	asap: string
	/** Pickup with a promised time: `{time}`. */
	readyAround: string
	/** Delivery with a promised range: `{from}`, `{to}`. */
	arriving: string
	/** Delivery with a promised start only: `{time}`. */
	arrivingAround: string
	viewOrder: string
	/** Receipt only, with the branded app's live stores (#196). */
	trackInApp: string
	storeAppStore: string
	storePlayStore: string
	welcomeBonusLine: string
	pointsUnit: string
	starsUnit: string
	footer: string
}

export type OrderMessageCopy = {
	kinds: Record<OrderMessageKind, OrderKindCopy>
	sms: {
		/** `{number}`, `{r}`. */
		ready: string
		/** `{number}`, `{r}`, `{time}`. */
		eta_changed: string
	}
	labels: OrderCopyLabels
}

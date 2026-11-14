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
	tax: string
	total: string
	refunded: string
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

import { z } from 'zod'

/**
 * The signed-in guest's own restaurant orders and "Order again" (#112). The
 * region answers `GET /customer/orders`, `GET /customer/orders/:id` and
 * `GET /customer/orders/:id/reorder` with these shapes; Sites and the customer
 * app read them. No prices ever travel in a reorder: the cart is priced again
 * from the live menu. No I/O.
 */

export const CUSTOMER_ORDERS_PAGE_SIZE = 50

/** One row of the guest's order list. Names are the menu's, as the order saw them. */
export type CustomerOrderListItem = {
	id: string
	number: string
	status: string
	paymentStatus: string
	paymentMethod: string
	fulfillment: string
	currency: string
	totalCents: number
	createdAt: string | null
	location: { id: string; name: string }
	/** Total quantity of dishes. */
	itemCount: number
	/** The first few dish names, as stored (a language map or plain text). */
	itemNames: string[]
	/** One-off drop orders are never reordered. */
	isDrop: boolean
	canReorder: boolean
	/** A lapsed, unpaid online order: "Finish this order" rebuilds its cart. */
	canFinish: boolean
}

export type CustomerOrdersPage = {
	orders: CustomerOrderListItem[]
	nextCursor: string | null
}

export const reorderOptionSchema = z.object({
	groupId: z.string(),
	optionId: z.string(),
	quantity: z.number().int().min(1).max(99),
	half: z.enum(['whole', 'left', 'right']).nullable(),
})

export const reorderLineSchema = z.object({
	itemId: z.string(),
	variantId: z.string().nullable(),
	quantity: z.number().int().min(1).max(99),
	options: z.array(reorderOptionSchema).max(100),
	instructions: z.string().max(500),
	/** The name the order carried, only so the guest can be told what is gone. */
	name: z.string().max(300),
})

export const reorderResponseSchema = z.object({
	locationId: z.string(),
	fulfillment: z.enum(['pickup', 'delivery']),
	lines: z.array(reorderLineSchema).max(200),
})
export type ReorderLine = z.infer<typeof reorderLineSchema>
export type ReorderResponse = z.infer<typeof reorderResponseSchema>

/** Fulfillments an order can be placed again with. A table round or a drop cannot. */
export const REORDERABLE_FULFILLMENTS = ['pickup', 'delivery'] as const

export function reorderableFulfillment(
	value: string,
): value is (typeof REORDERABLE_FULFILLMENTS)[number] {
	return (REORDERABLE_FULFILLMENTS as readonly string[]).includes(value)
}

/**
 * "Finish this order": an online order whose payment window lapsed. It never
 * took money, so rebuilding its cart is the way back to it.
 */
export function isLapsedUnpaidOnlineOrder(order: {
	status: string
	paymentMethod: string
	paymentStatus: string
}): boolean {
	return (
		order.status === 'expired' &&
		order.paymentMethod === 'online' &&
		order.paymentStatus !== 'paid'
	)
}

/**
 * The message for dishes left out: "2 items are no longer available". The
 * words are the caller's (they are translated there); this only counts.
 */
export function droppedCount(dropped: readonly unknown[]): number {
	return dropped.length
}

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

// ---------------------------------------------------------------------------
// The app's hand-off to the website cart
// ---------------------------------------------------------------------------

/** The fragment key the website reads an app's reorder lines from. */
export const REORDER_PAYLOAD_PARAM = 'reorderlines'

const ID = /^[A-Za-z0-9_-]{1,128}$/
const payloadOptionSchema = z.object({
	g: z.string().regex(ID),
	o: z.string().regex(ID),
	q: z.number().int().min(1).max(99).optional(),
	h: z.enum(['whole', 'left', 'right']).optional(),
})
const payloadLineSchema = z.object({
	i: z.string().regex(ID),
	v: z.string().regex(ID).optional(),
	q: z.number().int().min(1).max(99),
	o: z.array(payloadOptionSchema).max(100).optional(),
})
const payloadSchema = z.object({
	l: z.string().regex(ID),
	n: z.array(payloadLineSchema).min(1).max(200),
})

/** Ids and counts only (no names, prices or notes), so it is small and holds no guest text. */
export const REORDER_PAYLOAD_MAX_CHARS = 12_000

function toBase64Url(text: string): string {
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/')
	return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

/**
 * The customer app has no cart: it opens the website's menu with the order's
 * catalog ids in the URL fragment (never sent to a server). The website prices
 * the cart again from the live menu and leaves out what is gone.
 */
export function encodeReorderPayload(reorder: ReorderResponse): string | null {
	const payload = {
		l: reorder.locationId,
		n: reorder.lines.map((line) => ({
			i: line.itemId,
			...(line.variantId ? { v: line.variantId } : {}),
			q: line.quantity,
			...(line.options.length
				? {
						o: line.options.map((option) => ({
							g: option.groupId,
							o: option.optionId,
							...(option.quantity > 1 ? { q: option.quantity } : {}),
							...(option.half ? { h: option.half } : {}),
						})),
					}
				: {}),
		})),
	}
	if (!payloadSchema.safeParse(payload).success) return null
	const encoded = toBase64Url(JSON.stringify(payload))
	return encoded.length <= REORDER_PAYLOAD_MAX_CHARS ? encoded : null
}

export type DecodedReorderPayload = {
	locationId: string
	lines: Array<{
		itemId: string
		variantId?: string
		quantity: number
		options: Array<{
			groupId: string
			optionId: string
			quantity?: number
			half?: 'whole' | 'left' | 'right'
		}>
	}>
}

export function decodeReorderPayload(
	value: string | null | undefined,
): DecodedReorderPayload | null {
	if (!value || value.length > REORDER_PAYLOAD_MAX_CHARS) return null
	try {
		const parsed = payloadSchema.safeParse(JSON.parse(fromBase64Url(value)))
		if (!parsed.success) return null
		return {
			locationId: parsed.data.l,
			lines: parsed.data.n.map((line) => ({
				itemId: line.i,
				...(line.v ? { variantId: line.v } : {}),
				quantity: line.q,
				options: (line.o ?? []).map((option) => ({
					groupId: option.g,
					optionId: option.o,
					...(option.q ? { quantity: option.q } : {}),
					...(option.h ? { half: option.h } : {}),
				})),
			})),
		}
	} catch {
		return null
	}
}

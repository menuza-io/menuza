import {
	CUSTOMER_ORDERS_PAGE_SIZE,
	type CustomerOrderListItem,
	type CustomerOrdersPage,
	isLapsedUnpaidOnlineOrder,
	type ReorderResponse,
	reorderableFulfillment,
} from '@repo/common/customer-orders'
import { type PricedOrderLine } from '@repo/common/restaurant-orders'
import { restaurantOrders, type TenantDatabase } from '@repo/tenant-db'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import { badRequest } from '../lib/http.ts'

/**
 * The signed-in guest's own restaurant orders (#112). An order is the guest's
 * when its `customer_id` is theirs: never by name, email or phone, and never an
 * order that belongs to someone else. Every read filters on the customer id, so
 * an id that is not theirs is indistinguishable from one that does not exist
 * (the route answers the same 404 for both). Reads only: nothing here writes.
 */

type OrderRow = typeof restaurantOrders.$inferSelect
type Cursor = { t: number; id: string }

function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(raw: string | undefined): Cursor | null {
	if (!raw) return null
	try {
		const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
		if (
			parsed &&
			typeof parsed.t === 'number' &&
			Number.isFinite(parsed.t) &&
			typeof parsed.id === 'string' &&
			parsed.id.length <= 128
		) {
			return { t: parsed.t, id: parsed.id }
		}
	} catch {
		// fall through
	}
	throw badRequest('Invalid cursor')
}

function linesOf(order: OrderRow): PricedOrderLine[] {
	return Array.isArray(order.lines) ? (order.lines as PricedOrderLine[]) : []
}

export function listItemOf(order: OrderRow): CustomerOrderListItem {
	const lines = linesOf(order)
	const isDrop = Boolean(order.dropSlug)
	const reorderable =
		!isDrop && reorderableFulfillment(order.fulfillment) && lines.length > 0
	return {
		id: order.id,
		number: order.number,
		status: order.status,
		paymentStatus: order.paymentStatus,
		paymentMethod: order.paymentMethod,
		fulfillment: order.fulfillment,
		currency: order.currency,
		totalCents: order.totalCents,
		createdAt: order.createdAt ? order.createdAt.toISOString() : null,
		location: { id: order.locationId, name: order.locationName },
		itemCount: lines.reduce(
			(sum, line) => sum + (Number.isFinite(line.quantity) ? line.quantity : 0),
			0,
		),
		itemNames: lines.slice(0, 3).map((line) => line.itemName),
		isDrop,
		canReorder: reorderable,
		canFinish: reorderable && isLapsedUnpaidOnlineOrder(order),
	}
}

/** Newest first, 50 per page, by cursor. */
export async function listCustomerOrders(
	db: TenantDatabase,
	customerId: string,
	input: { cursor?: string } = {},
): Promise<CustomerOrdersPage> {
	const cursor = decodeCursor(input.cursor)
	// A free test order (#119) is not part of a guest's order history.
	const mine = and(
		eq(restaurantOrders.customerId, customerId),
		eq(restaurantOrders.isTest, false),
	)!
	const where = cursor
		? and(
				mine,
				or(
					lt(restaurantOrders.createdAt, new Date(cursor.t * 1000)),
					and(
						eq(restaurantOrders.createdAt, new Date(cursor.t * 1000)),
						lt(restaurantOrders.id, cursor.id),
					),
				),
			)
		: mine
	const rows = await db
		.select()
		.from(restaurantOrders)
		.where(where)
		.orderBy(desc(restaurantOrders.createdAt), desc(restaurantOrders.id))
		.limit(CUSTOMER_ORDERS_PAGE_SIZE + 1)
	const page = rows.slice(0, CUSTOMER_ORDERS_PAGE_SIZE)
	const last = page[page.length - 1]
	const nextCursor =
		rows.length > CUSTOMER_ORDERS_PAGE_SIZE && last?.createdAt
			? encodeCursor({
					t: Math.floor(last.createdAt.getTime() / 1000),
					id: last.id,
				})
			: null
	return { orders: page.map(listItemOf), nextCursor }
}

/** The guest's own order, or null for one that is not theirs or does not exist. */
export async function getCustomerOrder(
	db: TenantDatabase,
	customerId: string,
	orderId: string,
): Promise<OrderRow | null> {
	const row = await db
		.select()
		.from(restaurantOrders)
		.where(
			and(
				eq(restaurantOrders.id, orderId),
				eq(restaurantOrders.customerId, customerId),
			),
		)
		.get()
	return row ?? null
}

/**
 * What "Order again" needs: catalog ids and what the guest chose, never a
 * price. The client prices the cart again from the live menu, through the
 * normal constraints. A drop (a one-off event) and a table round cannot be
 * ordered again: `null`.
 */
export function reorderOf(order: OrderRow): ReorderResponse | null {
	if (order.dropSlug || !reorderableFulfillment(order.fulfillment)) return null
	const lines = linesOf(order)
	if (lines.length === 0) return null
	return {
		locationId: order.locationId,
		fulfillment: order.fulfillment,
		lines: lines.map((line) => ({
			itemId: line.itemId,
			variantId: line.variantId ?? null,
			quantity: Math.max(1, Math.min(99, Math.trunc(line.quantity) || 1)),
			options: (line.options ?? []).map((option) => ({
				groupId: option.groupId,
				optionId: option.optionId,
				quantity: Math.max(1, Math.min(99, Math.trunc(option.quantity) || 1)),
				half: option.half ?? null,
			})),
			instructions: (line.instructions ?? '').slice(0, 500),
			name: String(line.itemName ?? '').slice(0, 300),
		})),
	}
}

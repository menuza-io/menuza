import { restaurantOrders, type TenantDatabase } from '@repo/tenant-db'
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { badRequest } from '../lib/http.ts'
import { type DbOrTx } from './rsv-guest-service.ts'
import {
	requireCustomersFacet,
	resolvePerson,
	type PeopleAccess,
} from './people-service.ts'

/**
 * The orders of one person, for the Customers profile.
 *
 * Matching rule (documented in docs/reservations-people.md):
 *  - an order belongs to the customer when `customer_id` is that customer; and
 *  - when the customer's phone is VERIFIED, also when the order has no
 *    `customer_id` and its contact phone equals that phone (a guest checkout
 *    by the same, proven number).
 * Never by name or email, and never an order that belongs to another customer.
 * It needs the customers facet claim: host-only (dining) tokens get 403.
 */

export const PERSON_ORDERS_PAGE_SIZE = 20
const MAX_LIMIT = 50
/** Spend ignores orders that never became revenue. */
const NON_REVENUE_STATUSES = ['cancelled', 'expired', 'payment_review']

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

type OrderLine = { quantity?: unknown }

function itemCount(lines: unknown): number {
	if (!Array.isArray(lines)) return 0
	return (lines as OrderLine[]).reduce(
		(sum, line) =>
			sum + (typeof line?.quantity === 'number' ? line.quantity : 0),
		0,
	)
}

export type PersonOrderRow = {
	id: string
	number: string
	status: string
	paymentStatus: string
	fulfillment: string
	currency: string
	totalCents: number
	itemCount: number
	createdAt: string | null
	/** `customer`: bound at checkout. `phone`: matched by the verified phone. */
	matchedBy: 'customer' | 'phone'
}

export type PersonOrdersPage = {
	orders: PersonOrderRow[]
	nextCursor: string | null
	totals: {
		count: number
		/** Lifetime spend per currency, excluding cancelled and expired orders. */
		spend: Array<{ currency: string; cents: number }>
	}
}

export async function listPersonOrders(
	db: TenantDatabase | DbOrTx,
	access: PeopleAccess,
	rawKey: string,
	input: { cursor?: string; limit?: number } = {},
): Promise<PersonOrdersPage> {
	requireCustomersFacet(access)
	const person = await resolvePerson(db, access, rawKey)
	const customer = person.customer
	const empty: PersonOrdersPage = {
		orders: [],
		nextCursor: null,
		totals: { count: 0, spend: [] },
	}
	if (!customer) return empty

	const owned: SQL =
		customer.phoneVerified && customer.phone
			? (or(
					eq(restaurantOrders.customerId, customer.id),
					and(
						isNull(restaurantOrders.customerId),
						eq(restaurantOrders.contactPhone, customer.phone),
					),
				) as SQL)
			: eq(restaurantOrders.customerId, customer.id)

	const limit = Math.min(
		Math.max(input.limit ?? PERSON_ORDERS_PAGE_SIZE, 1),
		MAX_LIMIT,
	)
	const cursor = decodeCursor(input.cursor)
	const where = cursor
		? and(
				owned,
				or(
					lt(restaurantOrders.createdAt, new Date(cursor.t * 1000)),
					and(
						eq(restaurantOrders.createdAt, new Date(cursor.t * 1000)),
						lt(restaurantOrders.id, cursor.id),
					),
				),
			)
		: owned

	const rows = await db
		.select()
		.from(restaurantOrders)
		.where(where)
		.orderBy(desc(restaurantOrders.createdAt), desc(restaurantOrders.id))
		.limit(limit + 1)
	const page = rows.slice(0, limit)
	const last = page[page.length - 1]
	const nextCursor =
		rows.length > limit && last
			? encodeCursor({
					t: Math.floor((last.createdAt?.getTime() ?? 0) / 1000),
					id: last.id,
				})
			: null

	const totalsRows = await db
		.select({
			currency: restaurantOrders.currency,
			n: sql<number>`COUNT(*)`,
			spend: sql<number>`COALESCE(SUM(CASE WHEN ${restaurantOrders.status} IN (${sql.join(
				NON_REVENUE_STATUSES.map((s) => sql`${s}`),
				sql`, `,
			)}) THEN 0 ELSE ${restaurantOrders.totalCents} END), 0)`,
		})
		.from(restaurantOrders)
		.where(owned)
		.groupBy(restaurantOrders.currency)
	const spend = totalsRows
		.filter((row) => Number(row.spend) > 0)
		.map((row) => ({ currency: row.currency, cents: Number(row.spend) }))
	const total = totalsRows.reduce((sum, row) => sum + Number(row.n), 0)

	return {
		orders: page.map((order) => ({
			id: order.id,
			number: order.number,
			status: order.status,
			paymentStatus: order.paymentStatus,
			fulfillment: order.fulfillment,
			currency: order.currency,
			totalCents: order.totalCents,
			itemCount: itemCount(order.lines),
			createdAt: order.createdAt ? order.createdAt.toISOString() : null,
			matchedBy: order.customerId === customer.id ? 'customer' : 'phone',
		})),
		nextCursor,
		totals: { count: total, spend },
	}
}

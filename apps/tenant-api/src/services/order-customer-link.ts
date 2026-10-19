import { customers, restaurantOrders, rsvGuests } from '@repo/tenant-db'
import type { TenantDatabase } from '@repo/tenant-db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { personKey } from './people-service.ts'

/**
 * Which person page an order links to, for the Orders screen.
 *
 * What the token may link to comes from signed claims minted by the App (the
 * same rule as the Customers screen): `linkCustomers` opens `c_<id>` keys,
 * `linkGuests` opens `g_<id>` keys. Without a claim the key is always null, so
 * a menu-only operator learns nothing about people.
 *
 * Rule: an order with a `customer_id` links to that customer. Otherwise the
 * order's contact phone is matched, VERIFIED phones only, to a customer; failing
 * that, to a live reservation guest with no linked customer and the same phone.
 * Never by name or email.
 */
export type OrderLinkAccess = { linkCustomers: boolean; linkGuests: boolean }

const CHUNK = 50

function chunks<T>(values: T[]): T[][] {
	const out: T[][] = []
	for (let i = 0; i < values.length; i += CHUNK) {
		out.push(values.slice(i, i + CHUNK))
	}
	return out
}

type OrderRef = Pick<
	typeof restaurantOrders.$inferSelect,
	'id' | 'customerId' | 'contactPhone'
>

export async function resolveOrderCustomerKeys(
	db: TenantDatabase,
	orders: OrderRef[],
	access: OrderLinkAccess,
): Promise<Map<string, string | null>> {
	const result = new Map<string, string | null>()
	for (const order of orders) result.set(order.id, null)
	if (!access.linkCustomers && !access.linkGuests) return result

	const phones = [
		...new Set(
			orders
				.filter((o) => !o.customerId && o.contactPhone)
				.map((o) => o.contactPhone),
		),
	]
	const customerByPhone = new Map<string, string>()
	if (access.linkCustomers) {
		for (const part of chunks(phones)) {
			const rows = await db
				.select({ id: customers.id, phone: customers.phone })
				.from(customers)
				.where(
					and(
						inArray(customers.phone, part),
						eq(customers.phoneVerified, true),
					),
				)
			for (const row of rows)
				if (row.phone) customerByPhone.set(row.phone, row.id)
		}
	}

	const guestByPhone = new Map<string, string>()
	const guestByCustomer = new Map<string, string>()
	if (access.linkGuests) {
		for (const part of chunks(phones)) {
			const rows = await db
				.select({ id: rsvGuests.id, phone: rsvGuests.phoneE164 })
				.from(rsvGuests)
				.where(
					and(
						inArray(rsvGuests.phoneE164, part),
						isNull(rsvGuests.customerId),
						isNull(rsvGuests.mergedIntoId),
						isNull(rsvGuests.erasedAt),
					),
				)
			for (const row of rows) {
				if (row.phone && !guestByPhone.has(row.phone)) {
					guestByPhone.set(row.phone, row.id)
				}
			}
		}
		// A customer-bound order, for a token that may open guests but not customers.
		if (!access.linkCustomers) {
			const ids = [
				...new Set(orders.map((o) => o.customerId).filter(Boolean)),
			] as string[]
			for (const part of chunks(ids)) {
				const rows = await db
					.select({ id: rsvGuests.id, customerId: rsvGuests.customerId })
					.from(rsvGuests)
					.where(
						and(
							inArray(rsvGuests.customerId, part),
							isNull(rsvGuests.mergedIntoId),
							isNull(rsvGuests.erasedAt),
						),
					)
				for (const row of rows) {
					if (row.customerId) guestByCustomer.set(row.customerId, row.id)
				}
			}
		}
	}

	for (const order of orders) {
		if (order.customerId) {
			if (access.linkCustomers) {
				result.set(order.id, personKey('c', order.customerId))
			} else {
				const guestId = guestByCustomer.get(order.customerId)
				if (guestId) result.set(order.id, personKey('g', guestId))
			}
			continue
		}
		const customerId = customerByPhone.get(order.contactPhone)
		if (customerId) {
			result.set(order.id, personKey('c', customerId))
			continue
		}
		const guestId = guestByPhone.get(order.contactPhone)
		if (guestId) result.set(order.id, personKey('g', guestId))
	}
	return result
}

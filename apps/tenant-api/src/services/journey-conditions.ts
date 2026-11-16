import { type TenantDatabase } from '@repo/tenant-db'
import { sql } from 'drizzle-orm'
import { countedOrdersSql, DAY_MS } from './marketing-orders.ts'

/**
 * Condition fields that are computed from a guest's history instead of read
 * from the customer row (#99, #98). All are numbers or booleans: the run
 * timeline keeps the field, operator and result, never the value.
 */
export const VIRTUAL_CONDITION_FIELDS = [
	'orders_last_30_days',
	'orders_last_90_days',
	'days_since_last_order',
	'lifetime_spend',
	'has_upcoming_reservation',
] as const
export type VirtualConditionField = (typeof VIRTUAL_CONDITION_FIELDS)[number]

export function isVirtualConditionField(
	field: string,
): field is VirtualConditionField {
	return (VIRTUAL_CONDITION_FIELDS as readonly string[]).includes(field)
}

async function one(db: TenantDatabase, query: ReturnType<typeof sql>) {
	const rows = await db.all<{ v: number | null }>(query)
	return rows[0]?.v ?? null
}

/** The guest's current value for a computed field; `undefined` when there is none (a never-ordered guest has no last order). */
export async function virtualConditionValue(
	db: TenantDatabase,
	field: VirtualConditionField,
	customerId: string,
	now: number,
): Promise<number | boolean | undefined> {
	switch (field) {
		case 'orders_last_30_days':
		case 'orders_last_90_days': {
			const days = field === 'orders_last_30_days' ? 30 : 90
			const n = await one(
				db,
				sql`SELECT COUNT(*) AS v FROM ${countedOrdersSql()} o WHERE o.customer_id = ${customerId} AND o.ts >= ${now - days * DAY_MS}`,
			)
			return Number(n ?? 0)
		}
		case 'days_since_last_order': {
			const last = await one(
				db,
				sql`SELECT MAX(o.ts) AS v FROM ${countedOrdersSql()} o WHERE o.customer_id = ${customerId}`,
			)
			return last === null ? undefined : Math.floor((now - last) / DAY_MS)
		}
		case 'lifetime_spend': {
			const total = await one(
				db,
				sql`SELECT COALESCE(SUM(o.net), 0) AS v FROM ${countedOrdersSql()} o WHERE o.customer_id = ${customerId}`,
			)
			return Number(total ?? 0)
		}
		case 'has_upcoming_reservation': {
			const found = await one(
				db,
				sql`SELECT 1 AS v FROM rsv_reservations r JOIN rsv_guests g ON g.id = r.guest_id WHERE g.customer_id = ${customerId} AND g.merged_into_id IS NULL AND g.erased_at IS NULL AND r.start_at >= ${now} AND r.status IN ('booked', 'confirmed', 'pending_payment') LIMIT 1`,
			)
			return found !== null
		}
	}
}

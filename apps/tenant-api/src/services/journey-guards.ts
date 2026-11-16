import {
	JOURNEY_GOAL_REACHED_REASON,
	marketingMessages,
	marketingSettings,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm'
import { countedOrdersSql, DAY_MS } from './marketing-orders.ts'

/**
 * Two guards every marketing step passes through (#99): the goal ("stop when
 * the guest places an order") and the frequency cap (at most N marketing
 * messages per guest per 7 days, across broadcasts and automations).
 */

/**
 * A run waiting out a delay is checked at its next step: orders after it
 * started count. A run's start is stored to the second, so only an order after
 * the end of that second counts: the order that started the run (placed a
 * moment before) never ends it. An operator may also put `startedAtMs` in the
 * run context for an exact start (tests).
 */
export async function goalReachedForRun(
	db: TenantDatabase,
	run: {
		customerId: string
		startedAt: Date | null
		contextData?: unknown
	},
): Promise<boolean> {
	let startedMs = (run.startedAt?.getTime() ?? 0) + 1000
	try {
		const ctx =
			typeof run.contextData === 'string'
				? JSON.parse(run.contextData)
				: run.contextData
		const precise = (ctx as { startedAtMs?: unknown } | null)?.startedAtMs
		if (typeof precise === 'number') startedMs = precise
	} catch {}
	const rows = await db.all<{ found: number }>(
		sql`SELECT 1 AS found FROM ${countedOrdersSql()} o WHERE o.customer_id = ${run.customerId} AND o.ts > ${startedMs} LIMIT 1`,
	)
	return rows.length > 0
}

export { JOURNEY_GOAL_REACHED_REASON }

export type FrequencyCap = { limit: number; days: number }

export const FREQUENCY_CAP_KEY = 'frequency_cap'
export const DEFAULT_FREQUENCY_CAP: FrequencyCap = { limit: 3, days: 7 }

/** The saved cap, or null when none is set (no cap, as before this feature). */
export async function readFrequencyCap(
	db: TenantDatabase,
): Promise<FrequencyCap | null> {
	const row = await db
		.select({ value: marketingSettings.value })
		.from(marketingSettings)
		.where(eq(marketingSettings.key, FREQUENCY_CAP_KEY))
		.get()
	if (!row) return null
	const value = (
		typeof row.value === 'string' ? safeParse(row.value) : row.value
	) as { limit?: unknown; days?: unknown } | null
	if (!value || typeof value.limit !== 'number' || value.limit <= 0) return null
	const days = typeof value.days === 'number' && value.days > 0 ? value.days : 7
	return { limit: Math.floor(value.limit), days: Math.floor(days) }
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

/** Marketing messages a guest got (or is getting) inside the cap window; failed sends do not count. */
export async function marketingMessageCount(
	db: TenantDatabase,
	customerId: string,
	cap: FrequencyCap,
	now: number,
): Promise<number> {
	const rows = await db
		.select({ n: sql<number>`count(*)` })
		.from(marketingMessages)
		.where(
			and(
				eq(marketingMessages.customerId, customerId),
				gte(marketingMessages.sentAt, new Date(now - cap.days * DAY_MS)),
				ne(marketingMessages.status, 'Failed'),
			),
		)
	return Number(rows[0]?.n ?? 0)
}

/** Guests already at the cap, for a batch (a broadcast skips them). */
export async function cappedCustomerIds(
	db: TenantDatabase,
	customerIds: readonly string[],
	cap: FrequencyCap,
	now: number,
): Promise<Set<string>> {
	if (customerIds.length === 0) return new Set()
	const rows = await db
		.select({
			customerId: marketingMessages.customerId,
			n: sql<number>`count(*)`,
		})
		.from(marketingMessages)
		.where(
			and(
				// bounded: one broadcast batch (BROADCAST_BATCH_SIZE)
				inArray(marketingMessages.customerId, [...customerIds]),
				gte(marketingMessages.sentAt, new Date(now - cap.days * DAY_MS)),
				ne(marketingMessages.status, 'Failed'),
			),
		)
		.groupBy(marketingMessages.customerId)
	return new Set(
		rows
			.filter((row) => Number(row.n) >= cap.limit)
			.map((row) => row.customerId),
	)
}

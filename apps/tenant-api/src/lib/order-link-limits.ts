import {
	loyaltyRateCounters,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, gt, lt, sql } from 'drizzle-orm'
import { hmacHash } from './secrets.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * Durable limit for `POST /orders/:id/resend-link`: 3 receipt re-sends per
 * order per hour, counted in the organization's own database so it holds
 * across isolates, Durable Object evictions and Node restarts.
 *
 * It reuses the generic `loyalty_rate_counters` table (bucket, subject hash,
 * window start, count) under its own bucket, like `people-consent-limits.ts`:
 * no new table. The subject (the order) is stored only as a keyed hash.
 *
 * The hour slides: attempts are counted in 5-minute slots and every slot that
 * still overlaps the last hour counts, so an attempt weighs for 60 to 65
 * minutes and a burst at a boundary cannot spend two budgets. The attempt is
 * counted before the comparison, so parallel requests cannot slip past one
 * read and a refused attempt is not free. Rows of this bucket older than two
 * hours are pruned on every count (the loyalty tick prunes old rows too, and
 * never anything younger than two hours).
 */
export const ORDER_RESEND_LINK_LIMIT = {
	max: 3,
	windowMs: 60 * 60_000,
	slotMs: 5 * 60_000,
} as const

const BUCKET = 'order_resend_link'

export type OrderResendLimitResult =
	{ ok: true } | { ok: false; retryAfterSeconds: number }

/** Counts one re-send of `orderId` and says whether it fits the hour. */
export async function countOrderResendAttempt(
	db: TenantDatabase | TenantTransaction,
	input: { orgId: string; orderId: string },
	now = Date.now(),
): Promise<OrderResendLimitResult> {
	const { max, windowMs, slotMs } = ORDER_RESEND_LINK_LIMIT
	const slot = Math.floor(now / slotMs) * slotMs
	const subjectHash = hmacHash(
		`order-resend-link:${input.orgId}:${input.orderId}`,
	)
	// A slot still counts while any part of it is inside the last hour.
	const oldestCounted = now - windowMs - slotMs
	const rows = await retryOnSqliteBusy(async () => {
		await db
			.insert(loyaltyRateCounters)
			.values({ bucket: BUCKET, subjectHash, windowStart: slot, count: 1 })
			.onConflictDoUpdate({
				target: [
					loyaltyRateCounters.bucket,
					loyaltyRateCounters.subjectHash,
					loyaltyRateCounters.windowStart,
				],
				set: { count: sql`${loyaltyRateCounters.count} + 1` },
			})
		// bounded: at most 13 five-minute slots overlap one hour.
		return db
			.select({
				windowStart: loyaltyRateCounters.windowStart,
				count: loyaltyRateCounters.count,
			})
			.from(loyaltyRateCounters)
			.where(
				and(
					eq(loyaltyRateCounters.bucket, BUCKET),
					eq(loyaltyRateCounters.subjectHash, subjectHash),
					gt(loyaltyRateCounters.windowStart, oldestCounted),
				),
			)
	})
	await pruneOld(db, now).catch(() => {})
	const total = rows.reduce((sum, row) => sum + row.count, 0)
	if (total <= max) return { ok: true }
	const oldest = Math.min(...rows.map((row) => row.windowStart))
	return {
		ok: false,
		retryAfterSeconds: Math.max(
			1,
			Math.ceil((oldest + slotMs + windowMs - now) / 1000),
		),
	}
}

async function pruneOld(db: TenantDatabase | TenantTransaction, now: number) {
	await db
		.delete(loyaltyRateCounters)
		.where(
			and(
				eq(loyaltyRateCounters.bucket, BUCKET),
				lt(
					loyaltyRateCounters.windowStart,
					now - 2 * ORDER_RESEND_LINK_LIMIT.windowMs,
				),
			),
		)
}

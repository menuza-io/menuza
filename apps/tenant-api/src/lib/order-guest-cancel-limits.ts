import {
	loyaltyRateCounters,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { hmacHash } from './secrets.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * Durable limits for the guest's own cancel (#111): `GET` and `POST
 * /orders/:id/cancel`, per order and per client address, counted in the
 * organization's own database so they hold across isolates, Durable Object
 * evictions and Node restarts.
 *
 * Like `order-link-limits.ts` (the receipt re-send), the counters reuse the
 * generic `loyalty_rate_counters` table under their own buckets: no new
 * table. Subjects (the order id, the address bucket) are stored only as keyed
 * hashes. The window slides in one-minute slots, so an attempt weighs for 10
 * to 11 minutes and a burst at a boundary cannot spend two budgets. The
 * attempt is counted before the comparison, so a refusal is not free and
 * parallel requests cannot slip past one read. Rows of these buckets older
 * than two hours are pruned on every count (the loyalty tick prunes old rows
 * too, never anything younger than two hours).
 *
 * The cancel itself happens once per order; these numbers only stop a script
 * from hammering one order or walking many orders from one address.
 */
export const ORDER_GUEST_CANCEL_LIMITS = {
	/** Cancel attempts on one order. */
	cancelOrder: { max: 5, windowMs: 10 * 60_000 },
	/** Cancel attempts from one address, on any order of the organization. */
	cancelAddress: { max: 30, windowMs: 10 * 60_000 },
	/** "Can I still cancel?" reads of one order (the page asks on load). */
	checkOrder: { max: 60, windowMs: 10 * 60_000 },
	/** Those reads from one address. */
	checkAddress: { max: 300, windowMs: 10 * 60_000 },
	// Guest order problem reports (#191): sending one (and its photo), and the
	// page's read of the reports, per order and per address.
	problemOrder: { max: 8, windowMs: 10 * 60_000 },
	problemAddress: { max: 30, windowMs: 10 * 60_000 },
	problemReadOrder: { max: 60, windowMs: 10 * 60_000 },
	problemReadAddress: { max: 300, windowMs: 10 * 60_000 },
	// Group orders (#170): the page polls every 5 seconds, so reads are generous;
	// writes and joins are bounded per group and per address.
	groupReadGroup: { max: 4000, windowMs: 10 * 60_000 },
	groupReadAddress: { max: 400, windowMs: 10 * 60_000 },
	groupWriteGroup: { max: 600, windowMs: 10 * 60_000 },
	groupWriteAddress: { max: 80, windowMs: 10 * 60_000 },
	groupJoinAddress: { max: 20, windowMs: 10 * 60_000 },
} as const

export type OrderGuestCancelBucket = keyof typeof ORDER_GUEST_CANCEL_LIMITS

const BUCKET_NAMES: Record<OrderGuestCancelBucket, string> = {
	cancelOrder: 'order_guest_cancel.order',
	cancelAddress: 'order_guest_cancel.ip',
	checkOrder: 'order_guest_cancel_check.order',
	checkAddress: 'order_guest_cancel_check.ip',
	problemOrder: 'order_problem.order',
	problemAddress: 'order_problem.ip',
	problemReadOrder: 'order_problem_read.order',
	problemReadAddress: 'order_problem_read.ip',
	groupReadGroup: 'order_group_read.group',
	groupReadAddress: 'order_group_read.ip',
	groupWriteGroup: 'order_group_write.group',
	groupWriteAddress: 'order_group_write.ip',
	groupJoinAddress: 'order_group_join.ip',
}

const SLOT_MS = 60_000
const PRUNE_AFTER_MS = 2 * 60 * 60_000

export type OrderGuestCancelLimitResult =
	{ ok: true } | { ok: false; retryAfterSeconds: number }

/** Counts one attempt in `bucket` for `subject` and says whether it fits. */
export async function countOrderGuestCancelAttempt(
	db: TenantDatabase | TenantTransaction,
	bucket: OrderGuestCancelBucket,
	subject: string,
	now = Date.now(),
): Promise<OrderGuestCancelLimitResult> {
	const { max, windowMs } = ORDER_GUEST_CANCEL_LIMITS[bucket]
	const name = BUCKET_NAMES[bucket]
	const slot = Math.floor(now / SLOT_MS) * SLOT_MS
	const subjectHash = hmacHash(`order-guest-cancel-rate:${name}:${subject}`)
	// A slot still counts while any part of it is inside the window.
	const oldestCounted = now - windowMs - SLOT_MS
	const rows = await retryOnSqliteBusy(async () => {
		await db
			.insert(loyaltyRateCounters)
			.values({ bucket: name, subjectHash, windowStart: slot, count: 1 })
			.onConflictDoUpdate({
				target: [
					loyaltyRateCounters.bucket,
					loyaltyRateCounters.subjectHash,
					loyaltyRateCounters.windowStart,
				],
				set: { count: sql`${loyaltyRateCounters.count} + 1` },
			})
		// bounded: at most 11 one-minute slots overlap the window.
		return db
			.select({
				windowStart: loyaltyRateCounters.windowStart,
				count: loyaltyRateCounters.count,
			})
			.from(loyaltyRateCounters)
			.where(
				and(
					eq(loyaltyRateCounters.bucket, name),
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
			Math.ceil((oldest + SLOT_MS + windowMs - now) / 1000),
		),
	}
}

async function pruneOld(db: TenantDatabase | TenantTransaction, now: number) {
	await db.delete(loyaltyRateCounters).where(
		and(
			// bounded: the guest-cancel bucket names, a handful of fixed values.
			inArray(loyaltyRateCounters.bucket, Object.values(BUCKET_NAMES)),
			lt(loyaltyRateCounters.windowStart, now - PRUNE_AFTER_MS),
		),
	)
}

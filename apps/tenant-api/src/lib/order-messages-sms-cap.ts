import {
	loyaltyRateCounters,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, gt, lt, ne, sql } from 'drizzle-orm'
import { hmacHash } from './secrets.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * The per-organization cap on guest order texts (#79), reserved atomically
 * before a text is handed to the provider, in the organization's own database.
 *
 * It reuses the generic `loyalty_rate_counters` table (bucket, subject hash,
 * window start, count) under its own bucket, like `order-link-limits.ts`: no
 * new table. The subject is the organization, stored only as a keyed hash.
 *
 * Window: texts are counted in one-hour slots, and every slot that still
 * overlaps the last 24 hours counts, so a text weighs against the cap for 24 to
 * 25 hours after it was reserved (never less than a rolling day). A slot is
 * reserved with one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`, so
 * two senders at 199 cannot both pass: the one that gets 201 is refused and
 * gives its unit back. Rows of this bucket older than 26 hours are pruned on
 * every reservation; the loyalty tick's own purge leaves this bucket alone.
 */
export const ORDER_SMS_CAP = {
	/** Order texts per organization in any rolling 24 hours (see above). */
	max: 200,
	windowMs: 24 * 60 * 60_000,
	slotMs: 60 * 60_000,
} as const

/** Bucket name in `loyalty_rate_counters` (the loyalty purge skips it). */
export const ORDER_SMS_CAP_BUCKET = 'order_sms_daily'

function subjectFor(orgId: string): string {
	return hmacHash(`order-sms-daily:${orgId}`)
}

/**
 * Reserves one order text for the organization. True when it fits the cap
 * (the unit stays counted, whether the send then works or not); false when it
 * does not (the unit is given back, nothing may be sent).
 */
export async function reserveOrderSmsSlot(
	db: TenantDatabase | TenantTransaction,
	input: { orgId: string; max?: number },
	now = Date.now(),
): Promise<boolean> {
	const { windowMs, slotMs } = ORDER_SMS_CAP
	const max = input.max ?? ORDER_SMS_CAP.max
	const slot = Math.floor(now / slotMs) * slotMs
	const subjectHash = subjectFor(input.orgId)
	// A slot still counts while any part of it is inside the last 24 hours.
	const oldestCounted = now - windowMs - slotMs
	const total = await retryOnSqliteBusy(async () => {
		const [own] = await db
			.insert(loyaltyRateCounters)
			.values({
				bucket: ORDER_SMS_CAP_BUCKET,
				subjectHash,
				windowStart: slot,
				count: 1,
			})
			.onConflictDoUpdate({
				target: [
					loyaltyRateCounters.bucket,
					loyaltyRateCounters.subjectHash,
					loyaltyRateCounters.windowStart,
				],
				set: { count: sql`${loyaltyRateCounters.count} + 1` },
			})
			.returning({ count: loyaltyRateCounters.count })
		// bounded: at most 25 one-hour slots overlap one day.
		const earlier = await db
			.select({ count: loyaltyRateCounters.count })
			.from(loyaltyRateCounters)
			.where(
				and(
					eq(loyaltyRateCounters.bucket, ORDER_SMS_CAP_BUCKET),
					eq(loyaltyRateCounters.subjectHash, subjectHash),
					gt(loyaltyRateCounters.windowStart, oldestCounted),
					ne(loyaltyRateCounters.windowStart, slot),
				),
			)
		// This slot's count comes from the atomic increment itself, so parallel
		// reservations each see a different total.
		return (own?.count ?? 0) + earlier.reduce((sum, row) => sum + row.count, 0)
	})
	await pruneOld(db, now).catch(() => {})
	if (total <= max) return true
	await retryOnSqliteBusy(() =>
		db
			.update(loyaltyRateCounters)
			.set({ count: sql`max(${loyaltyRateCounters.count} - 1, 0)` })
			.where(
				and(
					eq(loyaltyRateCounters.bucket, ORDER_SMS_CAP_BUCKET),
					eq(loyaltyRateCounters.subjectHash, subjectHash),
					eq(loyaltyRateCounters.windowStart, slot),
				),
			),
	).catch(() => {
		// Giving the unit back is best effort: a lost one only refuses sooner.
	})
	return false
}

async function pruneOld(db: TenantDatabase | TenantTransaction, now: number) {
	await db
		.delete(loyaltyRateCounters)
		.where(
			and(
				eq(loyaltyRateCounters.bucket, ORDER_SMS_CAP_BUCKET),
				lt(
					loyaltyRateCounters.windowStart,
					now - ORDER_SMS_CAP.windowMs - 2 * ORDER_SMS_CAP.slotMs,
				),
			),
		)
}

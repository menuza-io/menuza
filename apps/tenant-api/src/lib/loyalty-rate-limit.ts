import { LoyaltyDomainError } from '@repo/loyalty'
import {
	loyaltyRateCounters,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, lt, sql } from 'drizzle-orm'
import { hmacHash } from './secrets.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * Durable fixed-window limits for loyalty lookups, codes, approvals and
 * holds, in the organization's own database. The subject (a customer, a
 * terminal, an approval, a client address) is stored only as a keyed hash.
 * The attempt is counted before the comparison, so a refusal is not free and
 * concurrent requests cannot slip past a shared read.
 */

export const LOYALTY_RATE_LIMITS = {
	/** A customer asking for member codes. */
	memberCode: { max: 10, windowMs: 10 * 60_000 },
	/** A terminal looking members up by code (guessing is the threat). */
	identify: { max: 30, windowMs: 10 * 60_000 },
	/** A terminal asking members to approve a spend. */
	approval: { max: 30, windowMs: 10 * 60_000 },
	/** One-time codes sent for one approval. */
	otpSend: { max: 3, windowMs: 60 * 60_000 },
	/** One-time codes sent to one member, across approvals. */
	otpSendMember: { max: 6, windowMs: 60 * 60_000 },
	/** Quotes and holds by a customer or terminal. */
	quote: { max: 120, windowMs: 10 * 60_000 },
	/** Wallet decisions by a customer. */
	customerWrite: { max: 30, windowMs: 10 * 60_000 },
} as const

export type LoyaltyRateBucket = keyof typeof LOYALTY_RATE_LIMITS

export async function enforceLoyaltyLimit(
	db: TenantDatabase | TenantTransaction,
	bucket: LoyaltyRateBucket,
	subject: string,
	now = Date.now(),
): Promise<void> {
	const { max, windowMs } = LOYALTY_RATE_LIMITS[bucket]
	const windowStart = Math.floor(now / windowMs) * windowMs
	const subjectHash = hmacHash(`loyalty-rate:${bucket}:${subject}`)
	const count = await retryOnSqliteBusy(async () => {
		await db
			.insert(loyaltyRateCounters)
			.values({ bucket, subjectHash, windowStart, count: 1 })
			.onConflictDoUpdate({
				target: [
					loyaltyRateCounters.bucket,
					loyaltyRateCounters.subjectHash,
					loyaltyRateCounters.windowStart,
				],
				set: { count: sql`${loyaltyRateCounters.count} + 1` },
			})
		const row = await db
			.select({ count: loyaltyRateCounters.count })
			.from(loyaltyRateCounters)
			.where(
				and(
					eq(loyaltyRateCounters.bucket, bucket),
					eq(loyaltyRateCounters.subjectHash, subjectHash),
					eq(loyaltyRateCounters.windowStart, windowStart),
				),
			)
			.get()
		return row?.count ?? 0
	})
	if (count > max) {
		throw new LoyaltyDomainError('rate_limited', {
			retryAfterSeconds: Math.max(
				1,
				Math.ceil((windowStart + windowMs - now) / 1000),
			),
		})
	}
}

/** Drops counter windows that can no longer matter (the tick calls it). */
export async function purgeLoyaltyRateCounters(
	db: TenantDatabase,
	now = Date.now(),
): Promise<void> {
	const longest = Math.max(
		...Object.values(LOYALTY_RATE_LIMITS).map((limit) => limit.windowMs),
	)
	await db
		.delete(loyaltyRateCounters)
		.where(lt(loyaltyRateCounters.windowStart, now - 2 * longest))
}

import {
	discountCodeAttempts,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { hmacHash } from './secrets.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * Durable limits for discount quotes and coupon guesses, in the
 * organization's own database. The subject (an address, a customer, the
 * organization) is stored only as a keyed hash. The attempt is counted before
 * the comparison.
 *
 * Coupon buckets use a sliding window estimated from two fixed windows (the
 * previous window's count weighted by how much of it still overlaps, plus the
 * current one), so a burst at a window boundary cannot spend two budgets.
 */

type Limit = { max: number; windowMs: number; sliding: boolean }

export const DISCOUNT_RATE_LIMITS = {
	/**
	 * Any quote from one address (and one customer, when signed in). Generous
	 * enough for a venue where every table shares one Wi-Fi address.
	 */
	quoteIp: { max: 120, windowMs: 60_000, sliding: false },
	/** Refused codes from one guest address. A re-quote of a code that applied does not count. */
	codeIp: { max: 20, windowMs: 10 * 60_000, sliding: true },
	/** Refused codes from one signed-in (verified) customer, wherever they are. */
	codeCustomer: { max: 20, windowMs: 10 * 60_000, sliding: true },
	/**
	 * Refused codes from guests for the whole organization. High enough that a
	 * busy venue cannot turn coupons off; a flood of guesses still stops.
	 * Signed-in customers never count toward it and are never refused by it.
	 */
	codeOrg: { max: 10_000, windowMs: 10 * 60_000, sliding: true },
} as const satisfies Record<string, Limit>

export type DiscountRateBucket = keyof typeof DISCOUNT_RATE_LIMITS

export type DiscountRateResult =
	{ ok: true } | { ok: false; retryAfterSeconds: number }

/** Rows older than this can no longer weigh on any window: two of the longest. */
const ATTEMPT_ROW_TTL_MS =
	2 *
	Math.max(
		...Object.values(DISCOUNT_RATE_LIMITS).map((limit) => limit.windowMs),
	)

function subjectHashOf(bucket: string, subject: string) {
	return hmacHash(`discount-rate:${bucket}:${subject}`)
}

function windowStartOf(windowMs: number, now: number) {
	return Math.floor(now / windowMs) * windowMs
}

function retryAfter(windowStart: number, windowMs: number, now: number) {
	return Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000))
}

/** The previous window's share that still overlaps the sliding window. */
function carriedOver(limit: Limit, previous: number, now: number) {
	if (!limit.sliding || previous <= 0) return 0
	const windowStart = windowStartOf(limit.windowMs, now)
	const overlap = 1 - (now - windowStart) / limit.windowMs
	return Math.floor(previous * overlap)
}

async function previousCount(
	db: TenantDatabase | TenantTransaction,
	bucket: string,
	subjectHash: string,
	limit: Limit,
	now: number,
): Promise<number> {
	if (!limit.sliding) return 0
	const row = await db
		.select({ count: discountCodeAttempts.count })
		.from(discountCodeAttempts)
		.where(
			and(
				eq(discountCodeAttempts.bucket, bucket),
				eq(discountCodeAttempts.subjectHash, subjectHash),
				eq(
					discountCodeAttempts.windowStart,
					windowStartOf(limit.windowMs, now) - limit.windowMs,
				),
			),
		)
		.get()
	return row?.count ?? 0
}

/**
 * Drops counter and marker rows that no window can read any more. Runs once
 * per counted request, so rows never outlive two windows by much.
 */
async function purgeStaleAttempts(
	db: TenantDatabase | TenantTransaction,
	now: number,
) {
	await db
		.delete(discountCodeAttempts)
		.where(lt(discountCodeAttempts.windowStart, now - ATTEMPT_ROW_TTL_MS))
}

/** True when this subject has already used its budget. Does not count one. */
export async function discountLimitOpen(
	db: TenantDatabase | TenantTransaction,
	bucket: DiscountRateBucket,
	subject: string,
	now = Date.now(),
): Promise<DiscountRateResult> {
	const limit: Limit = DISCOUNT_RATE_LIMITS[bucket]
	const windowStart = windowStartOf(limit.windowMs, now)
	const subjectHash = subjectHashOf(bucket, subject)
	const starts = limit.sliding
		? [windowStart, windowStart - limit.windowMs]
		: [windowStart]
	const rows = await db
		.select({
			windowStart: discountCodeAttempts.windowStart,
			count: discountCodeAttempts.count,
		})
		.from(discountCodeAttempts)
		.where(
			and(
				eq(discountCodeAttempts.bucket, bucket),
				eq(discountCodeAttempts.subjectHash, subjectHash),
				// bounded: `starts` holds at most two window starts.
				inArray(discountCodeAttempts.windowStart, starts),
			),
		)
	const current =
		rows.find((row) => row.windowStart === windowStart)?.count ?? 0
	const previous =
		rows.find((row) => row.windowStart !== windowStart)?.count ?? 0
	if (current + carriedOver(limit, previous, now) >= limit.max) {
		return {
			ok: false,
			retryAfterSeconds: retryAfter(windowStart, limit.windowMs, now),
		}
	}
	return { ok: true }
}

export type DiscountLimitRef = {
	bucket: string
	subjectHash: string
	windowStart: number
}

/**
 * Counts one attempt and answers from the count that one statement wrote
 * (`insert ... on conflict do update ... returning`), so parallel attempts
 * each see their own place in the line and the one past the limit is refused.
 * `ref` names the counter row so a counted attempt can be given back.
 */
async function incrementLimit(
	db: TenantDatabase | TenantTransaction,
	bucket: DiscountRateBucket,
	subject: string,
	now: number,
): Promise<DiscountRateResult & { ref: DiscountLimitRef }> {
	const limit: Limit = DISCOUNT_RATE_LIMITS[bucket]
	const windowStart = windowStartOf(limit.windowMs, now)
	const subjectHash = subjectHashOf(bucket, subject)
	const count = await retryOnSqliteBusy(async () => {
		const [row] = await db
			.insert(discountCodeAttempts)
			.values({ bucket, subjectHash, windowStart, count: 1 })
			.onConflictDoUpdate({
				target: [
					discountCodeAttempts.bucket,
					discountCodeAttempts.subjectHash,
					discountCodeAttempts.windowStart,
				],
				set: { count: sql`${discountCodeAttempts.count} + 1` },
			})
			.returning({ count: discountCodeAttempts.count })
		return row?.count ?? 0
	})
	const ref = { bucket, subjectHash, windowStart }
	const previous = await previousCount(db, bucket, subjectHash, limit, now)
	if (count + carriedOver(limit, previous, now) > limit.max) {
		return {
			ok: false,
			ref,
			retryAfterSeconds: retryAfter(windowStart, limit.windowMs, now),
		}
	}
	return { ok: true, ref }
}

export async function enforceDiscountLimit(
	db: TenantDatabase | TenantTransaction,
	bucket: DiscountRateBucket,
	subject: string,
	now = Date.now(),
): Promise<DiscountRateResult> {
	await purgeStaleAttempts(db, now)
	const { ref: ignoredRef, ...result } = await incrementLimit(
		db,
		bucket,
		subject,
		now,
	)
	return result
}

/** Gives one counted attempt back (never below zero). */
async function giveBack(
	db: TenantDatabase | TenantTransaction,
	ref: DiscountLimitRef,
) {
	await db
		.update(discountCodeAttempts)
		.set({
			count: sql`case when ${discountCodeAttempts.count} > 0 then ${discountCodeAttempts.count} - 1 else 0 end`,
		})
		.where(
			and(
				eq(discountCodeAttempts.bucket, ref.bucket),
				eq(discountCodeAttempts.subjectHash, ref.subjectHash),
				eq(discountCodeAttempts.windowStart, ref.windowStart),
			),
		)
}

async function deleteRow(
	db: TenantDatabase | TenantTransaction,
	ref: DiscountLimitRef,
) {
	await db
		.delete(discountCodeAttempts)
		.where(
			and(
				eq(discountCodeAttempts.bucket, ref.bucket),
				eq(discountCodeAttempts.subjectHash, ref.subjectHash),
				eq(discountCodeAttempts.windowStart, ref.windowStart),
			),
		)
}

/** A coupon attempt that was counted in advance, and can be given back. */
export type CouponGuessCharge = {
	counters: DiscountLimitRef[]
	/** The "this cart and code were already counted" marker. */
	marker: DiscountLimitRef
}

export type CouponGuessResult =
	| { ok: true; charge: CouponGuessCharge | null }
	| { ok: false; retryAfterSeconds: number }

/**
 * Who is guessing. A signed-in customer (a verified customer token) is
 * limited per customer and never by the organization's shared budget, so a
 * flood of guesses from fresh addresses cannot lock them out. A guest is
 * limited per address (`null`: every guest without one shares a bucket) and
 * by the organization's budget.
 */
export type CouponGuessSubject =
	| { kind: 'customer'; customerId: string }
	| { kind: 'guest'; address: string | null }

function bucketsFor(
	orgId: string,
	subject: CouponGuessSubject,
): { bucket: DiscountRateBucket; subject: string }[] {
	if (subject.kind === 'customer') {
		return [
			{ bucket: 'codeCustomer', subject: `${orgId}:${subject.customerId}` },
		]
	}
	return [
		{ bucket: 'codeIp', subject: `${orgId}:${subject.address ?? 'unknown'}` },
		{ bucket: 'codeOrg', subject: orgId },
	]
}

/**
 * Counts a coupon-code attempt before the code is checked, in each of the
 * subject's buckets (see `CouponGuessSubject`). Counting first closes the
 * window parallel requests used to pass through together.
 *
 * A subject already over a budget is refused before anything is written: no
 * marker and no count, so a refused flood neither grows the table nor spends
 * the organization's budget.
 *
 * `fingerprint` names the cart and code (the caller hashes whatever makes
 * two requests the same question). A second attempt with the same fingerprint
 * from the same subject in the same window is the page asking again after a
 * change that did not touch the code; it is not counted again. `charge` is
 * null in that case.
 *
 * When the code turns out to apply (or the request fails for another reason),
 * the caller hands `charge` to `refundCouponGuess`: only wrong guesses use up
 * the budget.
 */
export async function chargeCouponGuess(
	db: TenantDatabase | TenantTransaction,
	input: {
		orgId: string
		subject: CouponGuessSubject
		fingerprint: string
	},
	now = Date.now(),
): Promise<CouponGuessResult> {
	await purgeStaleAttempts(db, now)
	const buckets = bucketsFor(input.orgId, input.subject)
	for (const entry of buckets) {
		const open = await discountLimitOpen(db, entry.bucket, entry.subject, now)
		if (!open.ok) return open
	}
	const markerSubject =
		input.subject.kind === 'customer'
			? `c:${input.subject.customerId}`
			: `a:${input.subject.address ?? 'unknown'}`
	const markerRef: DiscountLimitRef = {
		bucket: 'codeSeen',
		subjectHash: hmacHash(
			`discount-rate:codeSeen:${input.orgId}:${markerSubject}:${input.fingerprint}`,
		),
		windowStart: windowStartOf(DISCOUNT_RATE_LIMITS.codeIp.windowMs, now),
	}
	const [inserted] = await db
		.insert(discountCodeAttempts)
		.values({ ...markerRef, count: 1 })
		.onConflictDoNothing()
		.returning({ count: discountCodeAttempts.count })
	// Already counted, and every budget is still open (checked above).
	if (!inserted) return { ok: true, charge: null }

	const counters: DiscountLimitRef[] = []
	for (const entry of buckets) {
		const counted = await incrementLimit(db, entry.bucket, entry.subject, now)
		counters.push(counted.ref)
		if (!counted.ok) {
			// Lost a race at the limit. The marker goes, so it does not linger
			// for a question that was never answered. Later buckets (the
			// organization's) are not touched.
			await deleteRow(db, markerRef)
			return { ok: false, retryAfterSeconds: counted.retryAfterSeconds }
		}
	}
	return { ok: true, charge: { counters, marker: markerRef } }
}

/** The code applied: the attempt was not a wrong guess, so it is given back. */
export async function refundCouponGuess(
	db: TenantDatabase | TenantTransaction,
	charge: CouponGuessCharge | null,
): Promise<void> {
	if (!charge) return
	for (const ref of charge.counters) await giveBack(db, ref)
	// The same cart and code is a fresh question again if it is refused later.
	await deleteRow(db, charge.marker)
}

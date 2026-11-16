import { GiftCardDomainError } from '@repo/common/gift-cards'
import {
	giftCardAttempts,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, lt, sql } from 'drizzle-orm'
import { giftCardHmac } from './gift-card-secret.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * Durable limits for wrong gift-card code guesses, in the organization's own
 * database, modelled on coupon codes. The subject (an address, a customer, a
 * terminal, the organization) is stored only as a keyed hash. A guess is
 * counted before the code is compared; a code that turns out right is given
 * back, so only wrong guesses use up a budget.
 *
 * Windows are fixed, so a client can spend up to twice a budget across a
 * window boundary. At 20 wrong guesses per 10 minutes against 80-bit codes that
 * is not exploitable. Guests whose address cannot be resolved share one
 * `unknown` bucket per organization; the balance check also needs Turnstile.
 */

type Limit = { max: number; windowMs: number }

export const GIFT_CARD_RATE_LIMITS = {
	/** Wrong codes from one address (an IPv6 client by its /64). */
	guessIp: { max: 20, windowMs: 10 * 60_000 },
	/** Wrong codes from one signed-in customer, wherever they are. */
	guessCustomer: { max: 20, windowMs: 10 * 60_000 },
	/** Wrong codes typed at one terminal. */
	guessDevice: { max: 30, windowMs: 10 * 60_000 },
	/**
	 * Wrong codes from guests across the organization. High enough that a busy
	 * venue never reaches it; a flood from many addresses still stops.
	 */
	guessOrg: { max: 10_000, windowMs: 10 * 60_000 },
	/** Purchases started from one address (each makes a pending card row). */
	purchaseIp: { max: 30, windowMs: 60 * 60_000 },
	/**
	 * Purchases started by one signed-in customer: a bearer token skips
	 * Turnstile, so this is what stops one account flooding pending cards.
	 */
	purchaseCustomer: { max: 10, windowMs: 60 * 60_000 },
} as const satisfies Record<string, Limit>

export type GiftCardRateBucket = keyof typeof GIFT_CARD_RATE_LIMITS

const ROW_TTL_MS =
	2 * Math.max(...Object.values(GIFT_CARD_RATE_LIMITS).map((l) => l.windowMs))

type Db = TenantDatabase | TenantTransaction

export type GiftCardLimitRef = {
	bucket: string
	subjectHash: string
	windowStart: number
}

function windowStartOf(windowMs: number, now: number) {
	return Math.floor(now / windowMs) * windowMs
}

async function increment(
	db: Db,
	bucket: GiftCardRateBucket,
	subject: string,
	now: number,
): Promise<{ ok: boolean; ref: GiftCardLimitRef; retryAfterSeconds: number }> {
	const { max, windowMs } = GIFT_CARD_RATE_LIMITS[bucket]
	const windowStart = windowStartOf(windowMs, now)
	const subjectHash = giftCardHmac(`gift-card-rate:${bucket}:${subject}`)
	const count = await retryOnSqliteBusy(async () => {
		const [row] = await db
			.insert(giftCardAttempts)
			.values({ bucket, subjectHash, windowStart, count: 1 })
			.onConflictDoUpdate({
				target: [
					giftCardAttempts.bucket,
					giftCardAttempts.subjectHash,
					giftCardAttempts.windowStart,
				],
				set: { count: sql`${giftCardAttempts.count} + 1` },
			})
			.returning({ count: giftCardAttempts.count })
		return row?.count ?? 0
	})
	return {
		ok: count <= max,
		ref: { bucket, subjectHash, windowStart },
		retryAfterSeconds: Math.max(
			1,
			Math.ceil((windowStart + windowMs - now) / 1000),
		),
	}
}

async function giveBack(db: Db, ref: GiftCardLimitRef) {
	await db
		.update(giftCardAttempts)
		.set({
			count: sql`case when ${giftCardAttempts.count} > 0 then ${giftCardAttempts.count} - 1 else 0 end`,
		})
		.where(
			and(
				eq(giftCardAttempts.bucket, ref.bucket),
				eq(giftCardAttempts.subjectHash, ref.subjectHash),
				eq(giftCardAttempts.windowStart, ref.windowStart),
			),
		)
}

export type GiftCardGuessSubject =
	| { kind: 'customer'; customerId: string; address: string | null }
	| { kind: 'device'; deviceId: string }
	| { kind: 'guest'; address: string | null }

export type GiftCardGuessCharge = { refs: GiftCardLimitRef[] }

function bucketsFor(
	orgId: string,
	subject: GiftCardGuessSubject,
): { bucket: GiftCardRateBucket; subject: string }[] {
	if (subject.kind === 'customer') {
		return [
			{ bucket: 'guessCustomer', subject: `${orgId}:${subject.customerId}` },
			...(subject.address
				? [
						{
							bucket: 'guessIp' as const,
							subject: `${orgId}:${subject.address}`,
						},
					]
				: []),
		]
	}
	if (subject.kind === 'device') {
		return [{ bucket: 'guessDevice', subject: `${orgId}:${subject.deviceId}` }]
	}
	return [
		{ bucket: 'guessIp', subject: `${orgId}:${subject.address ?? 'unknown'}` },
		{ bucket: 'guessOrg', subject: orgId },
	]
}

/**
 * Counts a guess before the code is checked, in each of the subject's
 * buckets. Over a limit throws 429 `rate_limited` having given back what this
 * attempt counted. The caller hands the charge to `settleGiftCardGuess`.
 */
export async function chargeGiftCardGuess(
	db: Db,
	input: { orgId: string; subject: GiftCardGuessSubject },
	now = Date.now(),
): Promise<GiftCardGuessCharge> {
	const refs: GiftCardLimitRef[] = []
	for (const entry of bucketsFor(input.orgId, input.subject)) {
		const counted = await increment(db, entry.bucket, entry.subject, now)
		refs.push(counted.ref)
		if (!counted.ok) {
			for (const ref of refs) await giveBack(db, ref)
			throw new GiftCardDomainError('rate_limited', {
				retryAfterSeconds: counted.retryAfterSeconds,
			})
		}
	}
	return { refs }
}

/** The code was right (or the answer said nothing about it): give the guess back. */
export async function settleGiftCardGuess(
	db: Db,
	charge: GiftCardGuessCharge,
	outcome: 'wrong' | 'right',
): Promise<void> {
	if (outcome === 'wrong') return
	for (const ref of charge.refs) await giveBack(db, ref)
}

/**
 * Counts one started purchase from an address and, when signed in, from the
 * customer; over either limit throws 429 (the address count is kept).
 */
export async function enforceGiftCardPurchaseLimit(
	db: Db,
	orgId: string,
	subject: { address: string | null; customerId?: string | null },
	now = Date.now(),
): Promise<void> {
	const buckets: { bucket: GiftCardRateBucket; subject: string }[] = [
		{
			bucket: 'purchaseIp',
			subject: `${orgId}:${subject.address ?? 'unknown'}`,
		},
		...(subject.customerId
			? [
					{
						bucket: 'purchaseCustomer' as const,
						subject: `${orgId}:${subject.customerId}`,
					},
				]
			: []),
	]
	for (const entry of buckets) {
		const counted = await increment(db, entry.bucket, entry.subject, now)
		if (!counted.ok) {
			throw new GiftCardDomainError('rate_limited', {
				retryAfterSeconds: counted.retryAfterSeconds,
			})
		}
	}
}

/**
 * Removes attempt rows whose window ended long ago. Runs in the regional tick,
 * not on the guess path, so an unauthenticated request never pays for a purge.
 */
export async function purgeGiftCardAttempts(
	db: Db,
	now = Date.now(),
): Promise<void> {
	await db
		.delete(giftCardAttempts)
		.where(lt(giftCardAttempts.windowStart, now - ROW_TTL_MS))
}

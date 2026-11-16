import {
	GIFT_CARD_IMMEDIATE_SLACK_MS,
	GiftCardDomainError,
	type GiftCardHoldReason,
	type GiftCardPaymentRisk,
	type GiftCardSettings,
} from '@repo/common/gift-cards'
import { giftCardPurchaseAttempts, giftCards } from '@repo/tenant-db'
import { and, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { type GiftCardReader } from '../lib/gift-card-write.ts'

/**
 * Purchase fraud rules (#218), all in the region on hashes and amounts:
 *
 * - limits are checked **before** payment and the refusal is one generic
 *   `purchase_limit`: it never says which limit was hit;
 * - a first-time buyer's immediate, high-value card is held for a short
 *   delay; a provider "elevated risk" payment or a payment card over its
 *   24-hour count is held for review;
 * - till sales (cash, present card) and till top-ups never come through
 *   here, so they are never delayed.
 */

const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

/** Purchases that still count toward a limit: not failed or lapsed ones. */
const COUNTED_PAYMENT_STATUSES = ['pending', 'paid', 'review'] as const

async function countRecent(
	db: GiftCardReader,
	column: 'emailHash' | 'deviceHash' | 'paymentHash',
	hash: string,
	since: number,
	excludeCardId?: string,
): Promise<number> {
	const attempts = giftCardPurchaseAttempts
	const row = await db
		.select({ count: sql<number>`count(*)` })
		.from(attempts)
		.innerJoin(giftCards, eq(giftCards.id, attempts.cardId))
		.where(
			and(
				eq(attempts[column], hash),
				gt(attempts.at, since),
				inArray(giftCards.paymentStatus, [...COUNTED_PAYMENT_STATUSES]),
				excludeCardId ? ne(attempts.cardId, excludeCardId) : undefined,
			),
		)
		.get()
	return Number(row?.count ?? 0)
}

/**
 * Refuses a purchase over the operator's limits, before any payment is
 * started: the card value, the purchase total, and how many were bought with
 * this email or from this device in 24 hours.
 */
export async function assertPurchaseWithinLimits(
	db: GiftCardReader,
	input: {
		settings: GiftCardSettings
		amountMinor: number
		emailHash: string | null
		deviceHash: string | null
		now: number
	},
): Promise<void> {
	const { limits } = input.settings
	if (
		input.amountMinor > limits.maxCardMajor * 100 ||
		input.amountMinor > limits.maxPerPurchaseMajor * 100
	) {
		throw new GiftCardDomainError('purchase_limit')
	}
	const since = input.now - DAY_MS
	for (const [column, hash] of [
		['emailHash', input.emailHash],
		['deviceHash', input.deviceHash],
	] as const) {
		if (!hash) continue
		if ((await countRecent(db, column, hash, since)) >= limits.maxPurchasesPer24h) {
			throw new GiftCardDomainError('purchase_limit')
		}
	}
}

/** Purchases from one device in the last hour, this one included (burst alert). */
export async function devicePurchasesLastHour(
	db: GiftCardReader,
	deviceHash: string,
	now: number,
): Promise<number> {
	return countRecent(db, 'deviceHash', deviceHash, now - HOUR_MS)
}

/** A first-time buyer: no other paid purchase with this email hash. */
export async function isFirstTimeBuyer(
	db: GiftCardReader,
	emailHash: string | null,
	cardId: string,
): Promise<boolean> {
	if (!emailHash) return true
	const row = await db
		.select({ count: sql<number>`count(*)` })
		.from(giftCardPurchaseAttempts)
		.innerJoin(giftCards, eq(giftCards.id, giftCardPurchaseAttempts.cardId))
		.where(
			and(
				eq(giftCardPurchaseAttempts.emailHash, emailHash),
				ne(giftCardPurchaseAttempts.cardId, cardId),
				eq(giftCards.paymentStatus, 'paid'),
				isNotNull(giftCards.paidAt),
			),
		)
		.get()
	return Number(row?.count ?? 0) === 0
}

/** How many paid purchases a payment card made in 24 hours, this one excluded. */
export async function paymentCardPurchasesLastDay(
	db: GiftCardReader,
	paymentHash: string,
	cardId: string,
	now: number,
): Promise<number> {
	return countRecent(db, 'paymentHash', paymentHash, now - DAY_MS, cardId)
}

export type ActivationDecision =
	| { status: 'active' }
	| { status: 'held'; reason: GiftCardHoldReason; holdUntil: number | null }

/**
 * What a freshly paid purchase becomes. Review (no release time) beats the
 * timed delay: elevated provider risk, or a payment card over its count.
 */
export function decideActivation(input: {
	settings: GiftCardSettings
	amountMinor: number
	deliverAt: number | null
	now: number
	firstTimeBuyer: boolean
	risk: GiftCardPaymentRisk | null
	paymentCardOverLimit: boolean
}): ActivationDecision {
	if (input.risk && input.risk.level !== 'normal') {
		return { status: 'held', reason: 'provider_risk', holdUntil: null }
	}
	if (input.paymentCardOverLimit) {
		return { status: 'held', reason: 'manual', holdUntil: null }
	}
	const { limits } = input.settings
	const immediate =
		input.deliverAt === null ||
		input.deliverAt <= input.now + GIFT_CARD_IMMEDIATE_SLACK_MS
	if (
		input.firstTimeBuyer &&
		immediate &&
		input.amountMinor >= limits.holdThresholdMajor * 100
	) {
		return {
			status: 'held',
			reason: 'first_buyer',
			holdUntil: input.now + limits.holdHours * HOUR_MS,
		}
	}
	return { status: 'active' }
}

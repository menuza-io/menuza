import {
	GIFT_CARD_MAX_DELIVER_AHEAD_MS,
	GIFT_CARD_PAYMENT_HOLD_MS,
	GiftCardDomainError,
	generateGiftCardCode,
	giftCardOrderRef,
	type GiftCardDesignKey,
	type GiftCardPaymentRisk,
	type GiftCardSettings,
} from '@repo/common/gift-cards'
import {
	giftCardLedger,
	giftCardPurchaseAttempts,
	giftCards,
	getTenantDb,
	type GiftCardRow,
} from '@repo/tenant-db'
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm'
import { giftCardFingerprint, sealGiftCardCode } from '../lib/gift-card-secret.ts'
import { postGiftCardNotify } from '../lib/gift-card-notify.ts'
import {
	withGiftCardWrite,
	type GiftCardIdempotency,
	type GiftCardTx,
} from '../lib/gift-card-write.ts'
import { derivePaymentToken, verifyPaymentToken } from './order-service.ts'
import {
	appendGiftCardEntry,
	getGiftCard,
	giftCardBalance,
} from './gift-card-store.ts'
import { assertAmountWithinSettings, expiryFor, insertGiftCard } from './gift-card-service.ts'
import {
	assertPurchaseWithinLimits,
	decideActivation,
	devicePurchasesLastHour,
	isFirstTimeBuyer,
	paymentCardPurchasesLastDay,
} from './gift-card-risk.ts'

/**
 * Online card purchases: a pending card the hosted checkout pays for through
 * the `gc:<id>` order ref, the quote / bind / paid-event bridge the App calls,
 * and what a paid purchase becomes (active, held for a short delay, held for
 * review). The card's code is generated here, sealed until delivery, and kept
 * only as a hash after that.
 */

type Fail = {
	ok: false
	failure: { status: number; code: string; message: string; details?: Record<string, unknown> }
}
const fail = (status: number, code: string, message: string): Fail => ({
	ok: false,
	failure: { status, code, message },
})

export type PurchaseInput = {
	orgId: string
	settings: GiftCardSettings
	currency: string
	locationId: string | null
	amountMinor: number
	/** A processing fee passed to the buyer: its own line, never in the balance. */
	feeMinor?: number
	designKey: GiftCardDesignKey
	recipient: { name: string | null; email: string } | null
	sendToSelf: boolean
	senderName: string | null
	message: string | null
	deliverAt: number | null
	purchaser: { customerId: string | null; name: string | null; email: string }
	locale: string | null
	deviceId: string | null
	/** A double click returns the same purchase instead of a second pending card. */
	idempotency?: GiftCardIdempotency
	now?: number
}

export type PurchaseStarted = {
	cardId: string
	orderRef: string
	/** Handed to the browser for the hosted checkout (`POST /resources/sites/order/checkout`). */
	paymentToken: string
	amountMinor: number
	feeMinor: number
	totalMinor: number
	currency: string
	holdExpiresAt: number
}

export async function createGiftCardPurchase(
	input: PurchaseInput,
): Promise<PurchaseStarted> {
	const feeMinor = input.feeMinor ?? 0
	assertAmountWithinSettings(input.amountMinor, input.settings, { custom: true })
	if (
		input.designKey !== 'custom' &&
		!input.settings.designs.some((d) => d.key === input.designKey && d.enabled)
	) {
		throw new GiftCardDomainError('invalid_request')
	}
	const recipient = input.sendToSelf
		? { name: input.purchaser.name, email: input.purchaser.email }
		: input.recipient
	if (!recipient?.email) throw new GiftCardDomainError('invalid_request')
	const now = input.now ?? Date.now()
	if (
		input.deliverAt !== null &&
		(input.deliverAt > now + GIFT_CARD_MAX_DELIVER_AHEAD_MS ||
			input.deliverAt < now - 60_000)
	) {
		throw new GiftCardDomainError('invalid_request')
	}
	const emailHash = giftCardFingerprint('email', input.purchaser.email)
	const deviceHash = input.deviceId ? giftCardFingerprint('device', input.deviceId) : null

	let burst = 0
	const started = await withGiftCardWrite(
		{ orgId: input.orgId, now, idempotency: input.idempotency },
		async (tx, ctx): Promise<PurchaseStarted> => {
		await assertPurchaseWithinLimits(tx, {
			settings: input.settings,
			amountMinor: input.amountMinor,
			emailHash,
			deviceHash,
			now: ctx.now,
		})
		const code = generateGiftCardCode()
		const { card } = await insertGiftCard(tx, {
			status: 'pending',
			source: 'online',
			currency: input.currency,
			now: ctx.now,
			expiresAt: null,
			locationId: input.locationId ?? input.settings.defaultLocationId,
			designKey: input.designKey,
			code,
			extra: {
				purchaserCustomerId: input.purchaser.customerId,
				purchaserName: input.purchaser.name,
				purchaserEmail: input.purchaser.email,
				recipientName: recipient.name,
				recipientEmail: recipient.email,
				senderName: input.senderName,
				message: input.message,
				sendToSelf: input.sendToSelf,
				sealedCode: sealGiftCardCode(code),
				locale: input.locale,
				deliverAt: input.deliverAt,
				purchaseAmountMinor: input.amountMinor,
				feeMinor,
				paymentStatus: 'pending',
				paymentHoldExpiresAt: ctx.now + GIFT_CARD_PAYMENT_HOLD_MS,
			},
		})
		await tx.insert(giftCardPurchaseAttempts).values({
			cardId: card.id,
			emailHash,
			deviceHash,
			amountMinor: input.amountMinor,
			at: ctx.now,
		})
		ctx.linkCard(card.id)
		if (deviceHash) {
			burst = await devicePurchasesLastHour(tx, deviceHash, ctx.now)
		}
		const orderRef = giftCardOrderRef(card.id)
		return {
			cardId: card.id,
			orderRef,
			paymentToken: derivePaymentToken(input.orgId, orderRef),
			amountMinor: input.amountMinor,
			feeMinor,
			totalMinor: input.amountMinor + feeMinor,
			currency: input.currency,
			holdExpiresAt: card.paymentHoldExpiresAt!,
		}
	})
	if (burst === input.settings.limits.burstPerHour) {
		void postGiftCardNotify({ orgId: input.orgId, kind: 'burst', count: burst })
	}
	return started
}

// ---------------------------------------------------------------------------
// The App's hosted-payment bridge for `gc:<id>`
// ---------------------------------------------------------------------------

function chargeOf(card: GiftCardRow): number {
	return (card.purchaseAmountMinor ?? 0) + card.feeMinor
}

/** `POST /api/orders/quote` for `gc:<id>`: amounts and state only. */
export async function getGiftCardQuote(
	orgId: string,
	cardId: string,
	paymentToken: string,
) {
	const db = await getTenantDb(orgId)
	const card = await getGiftCard(db, cardId)
	if (!card || card.source !== 'online' || card.purchaseAmountMinor === null) {
		return fail(404, 'order_not_found', 'Order not found.')
	}
	if (!verifyPaymentToken(orgId, giftCardOrderRef(card.id), paymentToken)) {
		return fail(403, 'invalid_payment_token', 'This payment link is not valid.')
	}
	const paid = card.paymentStatus === 'paid' || card.paymentStatus === 'review'
	const lapsed =
		card.paymentStatus === 'pending' &&
		card.paymentHoldExpiresAt !== null &&
		card.paymentHoldExpiresAt <= Date.now() &&
		!card.paymentSessionId
	return {
		ok: true as const,
		data: {
			orgId,
			orderId: giftCardOrderRef(card.id),
			totalCents: chargeOf(card),
			currency: card.currency,
			holdExpiresAt: card.paymentHoldExpiresAt
				? new Date(card.paymentHoldExpiresAt).toISOString()
				: null,
			status: card.status === 'voided' || lapsed ? 'cancelled' : 'accepted',
			paymentStatus: paid ? 'paid' : 'pending',
			...(card.paymentSessionId && card.paymentProcessor
				? { sessionId: card.paymentSessionId, processor: card.paymentProcessor }
				: {}),
		},
	}
}

/** Binds one provider session to the purchase, exactly once. */
export async function bindGiftCardPaymentSession(input: {
	orgId: string
	cardId: string
	sessionId: string
	processor: 'connect' | 'checkout'
}) {
	return withGiftCardWrite({ orgId: input.orgId }, async (tx, ctx) => {
		const card = await getGiftCard(tx, input.cardId)
		if (!card || card.source !== 'online' || card.purchaseAmountMinor === null) {
			return fail(404, 'order_not_found', 'Order not found.')
		}
		if (card.paymentStatus === 'paid' || card.paymentStatus === 'review') {
			return fail(409, 'payment_terminal', 'This purchase is already paid.')
		}
		if (card.status === 'voided') {
			return fail(409, 'hold_expired', 'This purchase has expired.')
		}
		if (card.paymentSessionId && card.paymentSessionId !== input.sessionId) {
			return fail(409, 'session_conflict', 'This purchase already has a payment session.')
		}
		if (card.paymentSessionId !== input.sessionId) {
			await tx
				.update(giftCards)
				.set({
					paymentSessionId: input.sessionId,
					paymentProcessor: input.processor,
					paymentStatus: 'pending',
					paymentEventAt: ctx.now,
					// A started hosted session lasts a while: keep the purchase alive.
					paymentHoldExpiresAt: ctx.now + GIFT_CARD_PAYMENT_HOLD_MS,
					updatedAt: ctx.now,
				})
				.where(eq(giftCards.id, card.id))
		}
		return {
			ok: true as const,
			data: {
				orgId: input.orgId,
				orderId: giftCardOrderRef(card.id),
				sessionId: input.sessionId,
				status: 'accepted',
				paymentStatus: 'pending',
			},
		}
	})
}

export type GiftCardPaymentEvent = {
	orgId: string
	cardId: string
	sessionId: string
	processor: 'connect' | 'checkout'
	status: 'paid' | 'failed' | 'expired'
	amountCents: number
	currency: string
	paymentId?: string
	risk?: GiftCardPaymentRisk
	settings: GiftCardSettings
	now?: number
}

/**
 * A verified payment event for a purchase. Paid issues the card's value and
 * makes it active, held for a short delay, or held for review; a payment that
 * lands on a lapsed purchase is kept as `review` for a manual refund. Failed
 * or expired sessions unbind, so the buyer can try again.
 */
export async function applyGiftCardPaymentEvent(input: GiftCardPaymentEvent) {
	const outcome = await withGiftCardWrite(
		{ orgId: input.orgId, now: input.now },
		async (tx, ctx) => {
			const card = await getGiftCard(tx, input.cardId)
			if (!card || card.source !== 'online') {
				return fail(404, 'order_not_found', 'Order not found.')
			}
			const result = (paymentStatus: string) => ({
				ok: true as const,
				data: {
					orgId: input.orgId,
					orderId: giftCardOrderRef(card.id),
					sessionId: input.sessionId,
					status: card.status,
					paymentStatus,
				},
				deliver: false,
			})
			if (card.paymentStatus === 'paid' || card.paymentStatus === 'review') {
				return result('paid')
			}
			const matches =
				card.paymentSessionId === input.sessionId &&
				card.paymentProcessor === input.processor &&
				chargeOf(card) === input.amountCents &&
				card.currency.toLowerCase() === input.currency.toLowerCase()
			if (input.status !== 'paid') {
				if (!matches) return result(card.paymentStatus)
				await tx
					.update(giftCards)
					.set(
						input.status === 'expired'
							? {
									status: 'voided',
									paymentStatus: 'expired',
									paymentEventAt: ctx.now,
									updatedAt: ctx.now,
								}
							: {
									// The buyer may try again with a new session.
									paymentSessionId: null,
									paymentProcessor: null,
									paymentStatus: 'pending',
									paymentEventAt: ctx.now,
									updatedAt: ctx.now,
								},
					)
					.where(eq(giftCards.id, card.id))
				return result(input.status === 'expired' ? 'expired' : 'pending')
			}
			if (!matches) {
				// Money moved for an amount or session we did not expect: keep it for review.
				await tx
					.update(giftCards)
					.set({ paymentStatus: 'review', paymentEventAt: ctx.now, updatedAt: ctx.now })
					.where(eq(giftCards.id, card.id))
				return result('review')
			}
			const lapsed = card.status === 'voided'
			if (lapsed) {
				await tx
					.update(giftCards)
					.set({
						paymentStatus: 'review',
						paymentId: input.paymentId ?? input.sessionId,
						paidAt: ctx.now,
						paymentEventAt: ctx.now,
						updatedAt: ctx.now,
					})
					.where(eq(giftCards.id, card.id))
				return result('review')
			}
			const paymentHash = input.risk?.paymentFingerprint
				? giftCardFingerprint('payment', input.risk.paymentFingerprint)
				: null
			const attempt = await tx
				.select({ emailHash: giftCardPurchaseAttempts.emailHash })
				.from(giftCardPurchaseAttempts)
				.where(eq(giftCardPurchaseAttempts.cardId, card.id))
				.get()
			if (paymentHash) {
				await tx
					.update(giftCardPurchaseAttempts)
					.set({ paymentHash })
					.where(eq(giftCardPurchaseAttempts.cardId, card.id))
			}
			const decision = decideActivation({
				settings: input.settings,
				amountMinor: card.purchaseAmountMinor ?? 0,
				deliverAt: card.deliverAt,
				now: ctx.now,
				firstTimeBuyer: await isFirstTimeBuyer(tx, attempt?.emailHash ?? null, card.id),
				risk: input.risk ?? null,
				paymentCardOverLimit: paymentHash
					? (await paymentCardPurchasesLastDay(tx, paymentHash, card.id, ctx.now)) >=
						input.settings.limits.maxPurchasesPer24h
					: false,
			})
			await tx
				.update(giftCards)
				.set({
					status: decision.status,
					holdReason: decision.status === 'held' ? decision.reason : null,
					holdUntil: decision.status === 'held' ? decision.holdUntil : null,
					paymentStatus: 'paid',
					paymentId: input.paymentId ?? input.sessionId,
					paidAt: ctx.now,
					paymentEventAt: ctx.now,
					activatedAt: decision.status === 'active' ? ctx.now : null,
					expiresAt: expiryFor(input.settings, ctx.now),
					updatedAt: ctx.now,
				})
				.where(eq(giftCards.id, card.id))
			await appendGiftCardEntry(tx, {
				cardId: card.id,
				kind: 'issue',
				amountMinor: card.purchaseAmountMinor ?? 0,
				sourceType: 'purchase',
				sourceId: input.paymentId ?? input.sessionId,
				channel: 'online',
				locationId: card.locationId,
				idempotencyKey: `issue:online:${card.id}`,
				at: ctx.now,
			})
			if (decision.status === 'held') {
				await appendGiftCardEntry(tx, {
					cardId: card.id,
					kind: 'event',
					amountMinor: 0,
					sourceType: 'system',
					channel: 'system',
					locationId: card.locationId,
					reason:
						decision.reason === 'first_buyer'
							? 'held: first-time buyer'
							: decision.reason === 'provider_risk'
								? 'held: payment provider risk'
								: 'held: review needed',
					idempotencyKey: `hold:${card.id}`,
					at: ctx.now,
				})
			}
			ctx.linkCard(card.id)
			const reviewHeld = decision.status === 'held' && decision.holdUntil === null
			return {
				...result('paid'),
				status: decision.status,
				deliver: true,
				reviewHeld,
			}
		},
	)
	if (outcome.ok) {
		if ('reviewHeld' in outcome && outcome.reviewHeld) {
			void postGiftCardNotify({ orgId: input.orgId, kind: 'needs_review', count: 1 })
		}
		// The buyer's receipt (and the card, when it is already due) go out after commit.
		if ('deliver' in outcome && outcome.deliver) {
			const { sendGiftCardMessages } = await import('./gift-card-messages.ts')
			await sendGiftCardMessages(input.orgId, { cardId: input.cardId }).catch(
				() => undefined,
			)
		}
	}
	if (!outcome.ok) return outcome
	return { ok: true as const, data: outcome.data }
}

// ---------------------------------------------------------------------------
// Disputes, review and the tick
// ---------------------------------------------------------------------------

/**
 * A disputed purchase freezes its card at once: it cannot be spent, and what
 * was spent before the freeze stays in the history. A lost dispute removes
 * what is left; a won one lifts the freeze. Dispute events carry ids only.
 */
export async function applyGiftCardDispute(input: {
	orgId: string
	cardId?: string
	sessionId?: string
	processor?: 'connect' | 'checkout'
	status: 'open' | 'won' | 'lost' | 'closed' | string
	now?: number
}) {
	const outcome = await withGiftCardWrite(
		{ orgId: input.orgId, now: input.now },
		async (tx, ctx) => {
			const card = input.cardId
				? await getGiftCard(tx, input.cardId)
				: input.sessionId
					? ((await tx
							.select()
							.from(giftCards)
							.where(
								and(
									eq(giftCards.paymentSessionId, input.sessionId),
									eq(giftCards.source, 'online'),
								),
							)
							.get()) ?? null)
					: null
			if (!card || card.source !== 'online') {
				return { ok: false as const, notFound: true }
			}
			ctx.linkCard(card.id)
			const status = input.status
			if (status === 'open') {
				if (card.status === 'frozen' || card.status === 'voided') {
					return { ok: true as const, cardId: card.id, status: card.status, changed: false }
				}
				const spent = await spentBefore(tx, card.id)
				await tx
					.update(giftCards)
					.set({
						status: 'frozen',
						frozenAt: ctx.now,
						freezeReason: 'dispute',
						updatedAt: ctx.now,
					})
					.where(eq(giftCards.id, card.id))
				await appendGiftCardEntry(tx, {
					cardId: card.id,
					kind: 'event',
					amountMinor: 0,
					sourceType: 'system',
					channel: 'system',
					locationId: card.locationId,
					reason: `frozen: dispute (spent before the freeze: ${spent})`,
					idempotencyKey: `freeze:${card.id}:${ctx.now}`,
					at: ctx.now,
				})
				return { ok: true as const, cardId: card.id, status: 'frozen', changed: true }
			}
			if (card.status !== 'frozen') {
				return { ok: true as const, cardId: card.id, status: card.status, changed: false }
			}
			if (status === 'lost') {
				const balance = await giftCardBalance(tx, card.id)
				await tx
					.update(giftCards)
					.set({ status: 'voided', updatedAt: ctx.now })
					.where(eq(giftCards.id, card.id))
				if (balance > 0) {
					await appendGiftCardEntry(tx, {
						cardId: card.id,
						kind: 'dispute_removal',
						amountMinor: -balance,
						sourceType: 'system',
						channel: 'system',
						locationId: card.locationId,
						reason: 'dispute lost',
						idempotencyKey: `dispute_removal:${card.id}`,
						at: ctx.now,
					})
				}
				return { ok: true as const, cardId: card.id, status: 'voided', changed: true }
			}
			// Won or closed in our favor: lift the freeze.
			await tx
				.update(giftCards)
				.set({ status: 'active', frozenAt: null, freezeReason: null, updatedAt: ctx.now })
				.where(eq(giftCards.id, card.id))
			await appendGiftCardEntry(tx, {
				cardId: card.id,
				kind: 'event',
				amountMinor: 0,
				sourceType: 'system',
				channel: 'system',
				locationId: card.locationId,
				reason: 'unfrozen: dispute won',
				idempotencyKey: `unfreeze:${card.id}:${ctx.now}`,
				at: ctx.now,
			})
			return { ok: true as const, cardId: card.id, status: 'active', changed: true }
		},
	)
	if (outcome.ok && outcome.changed && outcome.status === 'frozen') {
		void postGiftCardNotify({ orgId: input.orgId, kind: 'frozen', count: 1 })
	}
	return outcome
}

async function spentBefore(tx: GiftCardTx, cardId: string): Promise<number> {
	const row = await tx
		.select({
			total: sql<number>`coalesce(-sum(${giftCardLedger.amountMinor}), 0)`,
		})
		.from(giftCardLedger)
		.where(
			and(
				eq(giftCardLedger.cardId, cardId),
				inArray(giftCardLedger.kind, ['redeem', 'refund']),
			),
		)
		.get()
	return Number(row?.total ?? 0)
}

/** Review decision on a held card (`update:gift_card:any`): approve it or hold it back for a refund. */
export async function approveHeldGiftCard(input: {
	orgId: string
	cardId: string
	actor: { id: string | null; name: string | null }
	now?: number
}) {
	const outcome = await withGiftCardWrite(
		{ orgId: input.orgId, now: input.now },
		async (tx, ctx) => {
			const card = await getGiftCard(tx, input.cardId)
			if (!card) throw new GiftCardDomainError('not_found')
			if (card.status !== 'held') throw new GiftCardDomainError('not_held')
			ctx.linkCard(card.id)
			await tx
				.update(giftCards)
				.set({
					status: 'active',
					holdReason: null,
					holdUntil: null,
					activatedAt: ctx.now,
					updatedAt: ctx.now,
				})
				.where(and(eq(giftCards.id, card.id), eq(giftCards.status, 'held')))
			await appendGiftCardEntry(tx, {
				cardId: card.id,
				kind: 'event',
				amountMinor: 0,
				sourceType: 'adjust',
				channel: 'app',
				locationId: card.locationId,
				actor: input.actor,
				reason: 'approved after review',
				idempotencyKey: `approve:${card.id}`,
				at: ctx.now,
			})
			return { cardId: card.id, status: 'active' as const }
		},
	)
	const { sendGiftCardMessages } = await import('./gift-card-messages.ts')
	await sendGiftCardMessages(input.orgId, { cardId: input.cardId }).catch(() => undefined)
	return outcome
}

/**
 * Books the removal of a purchase's unspent balance ahead of a provider
 * refund, and answers what the App may refund: never more than the unspent
 * balance (`refund_exceeds_unspent`). The card is voided; the App then calls
 * the provider with the returned session and amount.
 */
export async function bookGiftCardPurchaseRefund(input: {
	orgId: string
	cardId: string
	/** Omit to refund everything unspent. */
	amountMinor?: number
	actor: { id: string | null; name: string | null }
	/** A retry of the same click returns the same facts (the App then retries the provider). */
	idempotency?: GiftCardIdempotency
	now?: number
}) {
	return withGiftCardWrite({ orgId: input.orgId, now: input.now, idempotency: input.idempotency }, async (tx, ctx) => {
		const card = await getGiftCard(tx, input.cardId)
		if (!card || card.source !== 'online') throw new GiftCardDomainError('not_found')
		if (card.paymentStatus !== 'paid' && card.paymentStatus !== 'review') {
			throw new GiftCardDomainError('invalid_request')
		}
		ctx.linkCard(card.id)
		const unspent = await giftCardBalance(tx, card.id)
		const amount = input.amountMinor ?? unspent
		if (!Number.isSafeInteger(amount) || amount <= 0) {
			throw new GiftCardDomainError('refund_exceeds_unspent', { unspentMinor: unspent })
		}
		if (amount > unspent) {
			throw new GiftCardDomainError('refund_exceeds_unspent', { unspentMinor: unspent })
		}
		await appendGiftCardEntry(tx, {
			cardId: card.id,
			kind: 'void',
			amountMinor: -amount,
			sourceType: 'purchase',
			sourceId: card.paymentId,
			channel: 'app',
			locationId: card.locationId,
			actor: input.actor,
			reason: 'purchase refunded',
			idempotencyKey: `purchase_refund:${card.id}:${amount}:${unspent}`,
			at: ctx.now,
		})
		// A refund that leaves a balance keeps the card; a full one voids it.
		if (amount === unspent) {
			await tx
				.update(giftCards)
				.set({ status: 'voided', updatedAt: ctx.now })
				.where(eq(giftCards.id, card.id))
		}
		return {
			cardId: card.id,
			refundMinor: amount,
			currency: card.currency,
			sessionId: card.paymentSessionId,
			processor: card.paymentProcessor,
			paymentId: card.paymentId,
			voided: amount === unspent,
		}
	})
}

export type GiftCardTickTotals = {
	released: number
	expired: number
	delivered: number
	failed: number
}

/**
 * The regional tick for gift cards: releases timed holds whose delay has
 * passed, voids purchases whose payment never started (or lapsed), and sends
 * the cards and receipts that are due. Idempotent; safe to run often.
 */
export async function runGiftCardTick(
	orgId: string,
	options: { now?: number } = {},
): Promise<GiftCardTickTotals> {
	const now = options.now ?? Date.now()
	const totals: GiftCardTickTotals = { released: 0, expired: 0, delivered: 0, failed: 0 }
	const db = await getTenantDb(orgId)

	const due = await db
		.select({ id: giftCards.id })
		.from(giftCards)
		.where(
			and(
				eq(giftCards.status, 'held'),
				eq(giftCards.holdReason, 'first_buyer'),
				isNotNull(giftCards.holdUntil),
				lte(giftCards.holdUntil, now),
			),
		)
		.limit(100)
	for (const row of due) {
		const released = await withGiftCardWrite({ orgId, now }, async (tx, ctx) => {
			const card = await getGiftCard(tx, row.id)
			if (!card || card.status !== 'held' || card.holdReason !== 'first_buyer') return false
			await tx
				.update(giftCards)
				.set({
					status: 'active',
					holdReason: null,
					holdUntil: null,
					activatedAt: ctx.now,
					updatedAt: ctx.now,
				})
				.where(and(eq(giftCards.id, card.id), eq(giftCards.status, 'held')))
			await appendGiftCardEntry(tx, {
				cardId: card.id,
				kind: 'event',
				amountMinor: 0,
				sourceType: 'system',
				channel: 'system',
				locationId: card.locationId,
				reason: 'released after the delivery delay',
				idempotencyKey: `release:${card.id}`,
				at: ctx.now,
			})
			return true
		})
		if (released) totals.released += 1
	}

	const lapsed = await db
		.select({ id: giftCards.id })
		.from(giftCards)
		.where(
			and(
				eq(giftCards.status, 'pending'),
				eq(giftCards.paymentStatus, 'pending'),
				isNotNull(giftCards.paymentHoldExpiresAt),
				lte(giftCards.paymentHoldExpiresAt, now),
			),
		)
		.limit(100)
	for (const row of lapsed) {
		await withGiftCardWrite({ orgId, now }, async (tx, ctx) => {
			await tx
				.update(giftCards)
				.set({ status: 'voided', paymentStatus: 'expired', updatedAt: ctx.now })
				.where(and(eq(giftCards.id, row.id), eq(giftCards.status, 'pending')))
		})
		totals.expired += 1
	}

	const { sendGiftCardMessages } = await import('./gift-card-messages.ts')
	const sent = await sendGiftCardMessages(orgId, { now })
	totals.delivered = sent.delivered
	totals.failed = sent.failed
	return totals
}


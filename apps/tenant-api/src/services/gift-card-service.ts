import {
	GiftCardDomainError,
	formatGiftCardCode,
	generateGiftCardCode,
	giftCardLast4,
	isGiftCardMinorAmount,
	type GiftCardChannel,
	type GiftCardSettings,
	type GiftCardSource,
	type GiftCardStatus,
} from '@repo/common/gift-cards'
import {
	giftCardLedger,
	giftCards,
	type GiftCardLedgerRow,
	type GiftCardRow,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { giftCardCodeHash } from '../lib/gift-card-secret.ts'
import {
	withGiftCardWrite,
	type GiftCardIdempotency,
	type GiftCardTx,
	type GiftCardWriteContext,
} from '../lib/gift-card-write.ts'
import { consumeShowTokenInTx } from './gift-card-account-service.ts'
import {
	appendGiftCardEntry,
	assertGiftCardSpendable,
	findGiftCardByCode,
	getGiftCard,
	giftCardBalance,
	type GiftCardActor,
} from './gift-card-store.ts'

/**
 * The gift-card operations. Each takes the organization's lock and one
 * transaction (`withGiftCardWrite`), checks the card's state, and appends
 * ledger entries; the balance is always the sum of those entries. Functions
 * ending `InTx` run inside a transaction the caller already holds (an order
 * placement, a payment event) and never take the lock themselves.
 */

export type CardMoney = { amountMinor: number }

/** A guest's QR token (not the code) is spent by the write that uses it. */
export const SHOW_TOKEN_PREFIX = 'gcs1.'

/**
 * The card a till names by what it scanned or typed: a one-use show token
 * (consumed here, in the write that spends it) or a card code.
 */
async function cardForTill(
	tx: GiftCardTx,
	code: string,
	now: number,
): Promise<GiftCardRow> {
	if (code.startsWith(SHOW_TOKEN_PREFIX)) {
		return consumeShowTokenInTx(tx, code, now)
	}
	const card = await findGiftCardByCode(tx, code)
	if (!card) throw new GiftCardDomainError('code_invalid')
	return card
}

function requireAmount(amountMinor: unknown): number {
	if (!isGiftCardMinorAmount(amountMinor)) {
		throw new GiftCardDomainError('amount_out_of_range')
	}
	return amountMinor
}

/** Settings bounds for a new card or a top-up (`amount_out_of_range` otherwise). */
export function assertAmountWithinSettings(
	amountMinor: number,
	settings: GiftCardSettings,
	options: { custom?: boolean } = {},
): void {
	if (
		amountMinor < settings.minAmountMinor ||
		amountMinor > settings.maxAmountMinor
	) {
		throw new GiftCardDomainError('amount_out_of_range', {
			minAmountMinor: settings.minAmountMinor,
			maxAmountMinor: settings.maxAmountMinor,
		})
	}
	if (
		options.custom &&
		!settings.allowCustomAmount &&
		!settings.presetsMinor.includes(amountMinor)
	) {
		throw new GiftCardDomainError('amount_out_of_range')
	}
}

/** The expiry of a card issued now, from the organization's settings. */
export function expiryFor(
	settings: Pick<GiftCardSettings, 'expiryMonths'>,
	now: number,
): number | null {
	if (!settings.expiryMonths) return null
	const date = new Date(now)
	date.setUTCMonth(date.getUTCMonth() + settings.expiryMonths)
	return date.getTime()
}

export type NewCardInput = {
	status: GiftCardStatus
	source: GiftCardSource
	currency: string
	now: number
	expiresAt: number | null
	locationId: string | null
	designKey?: string | null
	/** A code to use instead of drawing a fresh one (never stored: only hashed). */
	code?: string
	extra?: Partial<typeof giftCards.$inferInsert>
}

/** Inserts a card row with a fresh code; returns the row and the plain code. */
export async function insertGiftCard(
	tx: GiftCardTx,
	input: NewCardInput,
): Promise<{ card: GiftCardRow; code: string }> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const code = input.code ?? generateGiftCardCode()
		try {
			const [card] = await tx
				.insert(giftCards)
				.values({
					codeHash: giftCardCodeHash(code),
					last4: giftCardLast4(code),
					currency: input.currency,
					status: input.status,
					source: input.source,
					expiresAt: input.expiresAt,
					locationId: input.locationId,
					designKey: input.designKey ?? null,
					createdAt: input.now,
					updatedAt: input.now,
					...input.extra,
				})
				.returning()
			return { card: card!, code }
		} catch (error) {
			// A collision of two random 80-bit codes: draw again (a fixed code
			// that collides is the caller's clash).
			const text = error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : ''
			if (input.code || !text.includes('gift_cards.code_hash')) throw error
		}
	}
	throw new GiftCardDomainError('gift_cards_unavailable')
}

// ---------------------------------------------------------------------------
// Sell, activate, top up
// ---------------------------------------------------------------------------

export type SellGiftCardInput = {
	orgId: string
	/** A printed card's code (scanned) to activate; absent for a card with no plastic. */
	code?: string
	amountMinor: number
	currency: string
	locationId: string | null
	actor: GiftCardActor
	deviceId: string
	/** The till's id for this sale: a replay finds the same card. */
	clientRequestId: string
	paymentMethod: 'cash' | 'card' | 'other'
	settings: GiftCardSettings
	idempotency?: GiftCardIdempotency
	now?: number
}

export type SoldGiftCard = {
	cardId: string
	last4: string
	/** The full code, shown once (a sold digital card). Never stored. */
	code: string | null
	formattedCode: string | null
	balanceMinor: number
	currency: string
	status: GiftCardStatus
	expiresAt: number | null
	/** The ledger entry the till keeps as its sale reference. */
	saleRef: string
}

/**
 * Sells a card at the till: a new digital card with a code shown once, or a
 * printed card (scanned) that becomes active with the paid amount. Till sales
 * are never delayed. A replay (same `clientRequestId`) returns the same card
 * with no second entry.
 */
export async function sellGiftCard(input: SellGiftCardInput): Promise<SoldGiftCard> {
	const amountMinor = requireAmount(input.amountMinor)
	assertAmountWithinSettings(amountMinor, input.settings, { custom: true })
	return withGiftCardWrite(
		{ orgId: input.orgId, idempotency: input.idempotency, now: input.now },
		async (tx, ctx) => {
			const key = `issue:pos:${input.deviceId}:${input.clientRequestId}`
			const prior = await tx
				.select()
				.from(giftCardLedger)
				.where(eq(giftCardLedger.idempotencyKey, key))
				.get()
			if (prior) {
				const card = await getGiftCard(tx, prior.cardId)
				if (!card) throw new GiftCardDomainError('not_found')
				return soldView(card, null, prior, await giftCardBalance(tx, card.id))
			}
			let card: GiftCardRow
			let code: string | null = null
			if (input.code) {
				const found = await findGiftCardByCode(tx, input.code)
				if (!found) throw new GiftCardDomainError('code_invalid')
				card = await activatePrintedCard(tx, found, input, ctx)
			} else {
				const created = await insertGiftCard(tx, {
					status: 'active',
					source: 'pos',
					currency: input.currency,
					now: ctx.now,
					expiresAt: expiryFor(input.settings, ctx.now),
					locationId: input.locationId,
					designKey: input.settings.defaultDesign,
					extra: { activatedAt: ctx.now },
				})
				card = created.card
				code = created.code
			}
			ctx.linkCard(card.id)
			const { entry } = await appendGiftCardEntry(tx, {
				cardId: card.id,
				kind: 'issue',
				amountMinor,
				sourceType: 'purchase',
				sourceId: input.clientRequestId,
				channel: 'pos',
				locationId: input.locationId,
				actor: input.actor,
				reason: `sold:${input.paymentMethod}`,
				idempotencyKey: key,
				at: ctx.now,
			})
			return soldView(card, code, entry, await giftCardBalance(tx, card.id))
		},
	)
}

async function activatePrintedCard(
	tx: GiftCardTx,
	card: GiftCardRow,
	input: SellGiftCardInput,
	ctx: GiftCardWriteContext,
): Promise<GiftCardRow> {
	if (card.status === 'active') throw new GiftCardDomainError('already_active')
	if (card.status !== 'inactive') {
		assertGiftCardSpendable(card, ctx.now)
		throw new GiftCardDomainError('gift_card_not_active')
	}
	if (card.currency !== input.currency) {
		throw new GiftCardDomainError('currency_mismatch')
	}
	const [updated] = await tx
		.update(giftCards)
		.set({
			status: 'active',
			source: 'pos',
			activatedAt: ctx.now,
			expiresAt: expiryFor(input.settings, ctx.now),
			// Stock is counted at the printing location; the sale's location is
			// where the money was taken, kept on the ledger entry.
			locationId: card.locationId ?? input.locationId,
			updatedAt: ctx.now,
		})
		.where(and(eq(giftCards.id, card.id), eq(giftCards.status, 'inactive')))
		.returning()
	if (!updated) throw new GiftCardDomainError('already_active')
	return updated
}

function soldView(
	card: GiftCardRow,
	code: string | null,
	entry: GiftCardLedgerRow,
	balanceMinor: number,
): SoldGiftCard {
	return {
		cardId: card.id,
		last4: card.last4,
		code,
		formattedCode: code ? formatGiftCardCode(code) : null,
		balanceMinor,
		currency: card.currency,
		status: card.status,
		expiresAt: card.expiresAt,
		saleRef: entry.id,
	}
}

export type TopUpInput = {
	orgId: string
	code: string
	amountMinor: number
	locationId: string | null
	actor: GiftCardActor
	deviceId: string
	clientRequestId: string
	settings: GiftCardSettings
	idempotency?: GiftCardIdempotency
	now?: number
}

/** Adds money to an active card at the till. Never delayed or held. */
export async function topUpGiftCard(input: TopUpInput) {
	const amountMinor = requireAmount(input.amountMinor)
	assertAmountWithinSettings(amountMinor, input.settings, { custom: true })
	return withGiftCardWrite(
		{ orgId: input.orgId, idempotency: input.idempotency, now: input.now },
		async (tx, ctx) => {
			const card = await cardForTill(tx, input.code, ctx.now)
			ctx.linkCard(card.id)
			const key = `top_up:pos:${input.deviceId}:${input.clientRequestId}`
			const prior = await tx
				.select()
				.from(giftCardLedger)
				.where(eq(giftCardLedger.idempotencyKey, key))
				.get()
			if (!prior) assertGiftCardSpendable(card, ctx.now)
			const before = await giftCardBalance(tx, card.id)
			if (
				!prior &&
				before + amountMinor > input.settings.limits.maxCardMajor * 100
			) {
				throw new GiftCardDomainError('amount_out_of_range')
			}
			const { entry } = await appendGiftCardEntry(tx, {
				cardId: card.id,
				kind: 'top_up',
				amountMinor,
				sourceType: 'purchase',
				sourceId: input.clientRequestId,
				channel: 'pos',
				locationId: input.locationId,
				actor: input.actor,
				idempotencyKey: key,
				at: ctx.now,
			})
			return {
				cardId: card.id,
				last4: card.last4,
				balanceMinor: await giftCardBalance(tx, card.id),
				currency: card.currency,
				saleRef: entry.id,
			}
		},
	)
}

// ---------------------------------------------------------------------------
// Redeem
// ---------------------------------------------------------------------------

export type RedeemInTxInput = {
	card: GiftCardRow
	amountMinor: number
	sourceType: 'restaurant_order' | 'pos_order' | 'manual_charge'
	sourceId: string
	channel: GiftCardChannel
	locationId: string | null
	actor?: GiftCardActor | null
	reason?: string | null
	note?: string | null
	/** Stable per fact (an order, a till request, a charge request). */
	idempotencyKey: string
	now: number
}

/**
 * Takes `amountMinor` off a card inside a transaction the caller holds. Never
 * more than the balance (`gift_card_balance_low`, with the balance). The
 * ledger trigger is the last line against two writers racing.
 */
export async function redeemGiftCardInTx(
	tx: GiftCardTx,
	input: RedeemInTxInput,
): Promise<{ entry: GiftCardLedgerRow; balanceMinor: number; replayed: boolean }> {
	const amountMinor = requireAmount(input.amountMinor)
	const existing = await tx
		.select()
		.from(giftCardLedger)
		.where(eq(giftCardLedger.idempotencyKey, input.idempotencyKey))
		.get()
	if (existing) {
		// A replay must not re-check a card that has since been spent down.
		const { entry } = await appendGiftCardEntry(tx, {
			cardId: input.card.id,
			kind: 'redeem',
			amountMinor: -amountMinor,
			sourceType: input.sourceType,
			sourceId: input.sourceId,
			channel: input.channel,
			locationId: input.locationId,
			idempotencyKey: input.idempotencyKey,
			at: input.now,
		})
		return {
			entry,
			balanceMinor: await giftCardBalance(tx, input.card.id),
			replayed: true,
		}
	}
	assertGiftCardSpendable(input.card, input.now)
	const balance = await giftCardBalance(tx, input.card.id)
	if (amountMinor > balance) {
		throw new GiftCardDomainError('gift_card_balance_low', {
			balanceMinor: balance,
		})
	}
	const { entry } = await appendGiftCardEntry(tx, {
		cardId: input.card.id,
		kind: 'redeem',
		amountMinor: -amountMinor,
		sourceType: input.sourceType,
		sourceId: input.sourceId,
		channel: input.channel,
		locationId: input.locationId,
		actor: input.actor ?? null,
		reason: input.reason ?? null,
		note: input.note ?? null,
		idempotencyKey: input.idempotencyKey,
		at: input.now,
	})
	return { entry, balanceMinor: balance - amountMinor, replayed: false }
}

export type TillRedeemInput = {
	orgId: string
	code: string
	amountMinor: number
	/** The till's sale id the payment will be recorded on. */
	saleId: string
	clientRequestId: string
	deviceId: string
	locationId: string | null
	actor: GiftCardActor
	idempotency?: GiftCardIdempotency
	now?: number
}

/** Redeems at the till (online only): takes at most the balance, and the till records the tender. */
export async function redeemGiftCardAtTill(input: TillRedeemInput) {
	const amountMinor = requireAmount(input.amountMinor)
	return withGiftCardWrite(
		{ orgId: input.orgId, idempotency: input.idempotency, now: input.now },
		async (tx, ctx) => {
			const card = await cardForTill(tx, input.code, ctx.now)
			ctx.linkCard(card.id)
			const result = await redeemGiftCardInTx(tx, {
				card,
				amountMinor,
				sourceType: 'pos_order',
				sourceId: input.saleId,
				channel: 'pos',
				locationId: input.locationId,
				actor: input.actor,
				idempotencyKey: `redeem:pos:${input.deviceId}:${input.clientRequestId}`,
				now: ctx.now,
			})
			return {
				cardId: card.id,
				last4: card.last4,
				redeemedMinor: amountMinor,
				balanceMinor: result.balanceMinor,
				currency: card.currency,
				reference: result.entry.id,
			}
		},
	)
}

/**
 * Gives back to a card, inside a transaction the caller holds, what one
 * redemption took (an order cancelled or refunded, a charge refunded). Never
 * more than that redemption took: the ledger trigger refuses the excess
 * (`gift_card_refund_exceeds_charge`). Works on any card status: money owed
 * back is never stranded by a void or an expiry.
 */
export async function refundGiftCardInTx(
	tx: GiftCardTx,
	input: {
		redeemEntryId: string
		amountMinor: number
		idempotencyKey: string
		actor?: GiftCardActor | null
		reason?: string | null
		now: number
	},
): Promise<{ entry: GiftCardLedgerRow; replayed: boolean }> {
	const amountMinor = requireAmount(input.amountMinor)
	const redeem = await tx
		.select()
		.from(giftCardLedger)
		.where(
			and(
				eq(giftCardLedger.id, input.redeemEntryId),
				eq(giftCardLedger.kind, 'redeem'),
			),
		)
		.get()
	if (!redeem) throw new GiftCardDomainError('not_found')
	if (amountMinor > -redeem.amountMinor) {
		throw new GiftCardDomainError('gift_card_refund_exceeds_charge')
	}
	return appendGiftCardEntry(tx, {
		cardId: redeem.cardId,
		kind: 'refund',
		amountMinor,
		sourceType: redeem.sourceType,
		sourceId: redeem.sourceId,
		channel: redeem.channel,
		// The refund reverses the redemption at the location that took it.
		locationId: redeem.locationId,
		actor: input.actor ?? null,
		reason: input.reason ?? null,
		refEntryId: redeem.id,
		idempotencyKey: input.idempotencyKey,
		at: input.now,
	})
}

// ---------------------------------------------------------------------------
// Adjust, void, charge from the App
// ---------------------------------------------------------------------------

export type AdjustInput = {
	orgId: string
	cardId: string
	/** The balance the operator saw; a different one is `stale_balance`. */
	expectedBalanceMinor: number
	deltaMinor: number
	reason: string
	actor: GiftCardActor
	idempotency?: GiftCardIdempotency
	now?: number
}

/** Adjusts a balance: needs the expected balance, a reason and a named operator. */
export async function adjustGiftCard(input: AdjustInput) {
	if (!Number.isSafeInteger(input.deltaMinor) || input.deltaMinor === 0) {
		throw new GiftCardDomainError('invalid_request')
	}
	const reason = input.reason.trim()
	if (!reason || reason.length > 500 || !input.actor.id) {
		throw new GiftCardDomainError('invalid_request')
	}
	return withGiftCardWrite(
		{ orgId: input.orgId, idempotency: input.idempotency, now: input.now },
		async (tx, ctx) => {
			const card = await getGiftCard(tx, input.cardId)
			if (!card) throw new GiftCardDomainError('not_found')
			ctx.linkCard(card.id)
			const balance = await giftCardBalance(tx, card.id)
			if (balance !== input.expectedBalanceMinor) {
				throw new GiftCardDomainError('stale_balance', { balanceMinor: balance })
			}
			if (balance + input.deltaMinor < 0) {
				throw new GiftCardDomainError('gift_card_balance_low', {
					balanceMinor: balance,
				})
			}
			const { entry } = await appendGiftCardEntry(tx, {
				cardId: card.id,
				kind: 'adjust',
				amountMinor: input.deltaMinor,
				sourceType: 'adjust',
				sourceId: null,
				channel: 'app',
				locationId: card.locationId,
				actor: input.actor,
				reason,
				idempotencyKey: `adjust:${card.id}:${input.idempotency?.key ?? `${ctx.now}:${balance}:${input.deltaMinor}`}`,
				at: ctx.now,
			})
			return {
				cardId: card.id,
				balanceMinor: balance + input.deltaMinor,
				entryId: entry.id,
			}
		},
	)
}

export type VoidInput = {
	orgId: string
	cardId: string
	reason: string
	actor: GiftCardActor
	idempotency?: GiftCardIdempotency
	now?: number
}

/**
 * Voids a card: any balance left is removed and the card can no longer be
 * spent or activated. Voiding twice is a no-op that returns the same answer.
 */
export async function voidGiftCard(input: VoidInput) {
	const reason = input.reason.trim()
	if (!reason || reason.length > 500) {
		throw new GiftCardDomainError('invalid_request')
	}
	return withGiftCardWrite(
		{ orgId: input.orgId, idempotency: input.idempotency, now: input.now },
		async (tx, ctx) => {
			const card = await getGiftCard(tx, input.cardId)
			if (!card) throw new GiftCardDomainError('not_found')
			ctx.linkCard(card.id)
			const balance = await giftCardBalance(tx, card.id)
			if (card.status === 'voided') {
				return { cardId: card.id, status: 'voided' as const, removedMinor: 0 }
			}
			await tx
				.update(giftCards)
				.set({ status: 'voided', updatedAt: ctx.now })
				.where(eq(giftCards.id, card.id))
			if (balance > 0) {
				await appendGiftCardEntry(tx, {
					cardId: card.id,
					kind: 'void',
					amountMinor: -balance,
					sourceType: 'adjust',
					channel: 'app',
					locationId: card.locationId,
					actor: input.actor,
					reason,
					idempotencyKey: `void:${card.id}`,
					at: ctx.now,
				})
			} else {
				await appendGiftCardEntry(tx, {
					cardId: card.id,
					kind: 'event',
					amountMinor: 0,
					sourceType: 'adjust',
					channel: 'app',
					locationId: card.locationId,
					actor: input.actor,
					reason: `voided: ${reason}`,
					idempotencyKey: `void:${card.id}`,
					at: ctx.now,
				})
			}
			return { cardId: card.id, status: 'voided' as const, removedMinor: balance }
		},
	)
}

export type ChargeInput = {
	orgId: string
	cardId: string
	amountMinor: number
	/** What it is for (required): shown in the history. */
	note: string
	/** An order, catering quote or payment link the charge counts toward. */
	attachTo?: { kind: 'restaurant_order' | 'quote' | 'payment_link'; id: string } | null
	locationId: string | null
	actor: GiftCardActor
	clientRequestId: string
	idempotency?: GiftCardIdempotency
	now?: number
}

/** Charges a card from the App (a phone or invoice payment). Over the balance is refused. */
export async function chargeGiftCard(input: ChargeInput) {
	const amountMinor = requireAmount(input.amountMinor)
	const note = input.note.trim()
	if (!note || note.length > 500 || !input.actor.id) {
		throw new GiftCardDomainError('invalid_request')
	}
	return withGiftCardWrite(
		{ orgId: input.orgId, idempotency: input.idempotency, now: input.now },
		async (tx, ctx) => {
			const card = await getGiftCard(tx, input.cardId)
			if (!card) throw new GiftCardDomainError('not_found')
			ctx.linkCard(card.id)
			const result = await redeemGiftCardInTx(tx, {
				card,
				amountMinor,
				sourceType: 'manual_charge',
				sourceId: input.attachTo?.id ?? input.clientRequestId,
				channel: 'app',
				locationId: input.locationId ?? card.locationId,
				actor: input.actor,
				reason: input.attachTo ? `charge:${input.attachTo.kind}` : 'charge',
				note,
				idempotencyKey: `charge:${card.id}:${input.clientRequestId}`,
				now: ctx.now,
			})
			return {
				cardId: card.id,
				chargeId: result.entry.id,
				chargedMinor: amountMinor,
				balanceMinor: result.balanceMinor,
			}
		},
	)
}

export type RefundChargeInput = {
	orgId: string
	cardId: string
	chargeId: string
	amountMinor: number
	actor: GiftCardActor
	clientRequestId: string
	idempotency?: GiftCardIdempotency
	now?: number
}

/** Refunds a charge back to the card from its own history line; never more than it took. */
export async function refundGiftCardCharge(input: RefundChargeInput) {
	const amountMinor = requireAmount(input.amountMinor)
	return withGiftCardWrite(
		{ orgId: input.orgId, idempotency: input.idempotency, now: input.now },
		async (tx, ctx) => {
			const charge = await tx
				.select()
				.from(giftCardLedger)
				.where(
					and(
						eq(giftCardLedger.id, input.chargeId),
						eq(giftCardLedger.cardId, input.cardId),
						eq(giftCardLedger.sourceType, 'manual_charge'),
						eq(giftCardLedger.kind, 'redeem'),
					),
				)
				.get()
			if (!charge) throw new GiftCardDomainError('not_found')
			ctx.linkCard(input.cardId)
			const { entry } = await refundGiftCardInTx(tx, {
				redeemEntryId: charge.id,
				amountMinor,
				idempotencyKey: `charge_refund:${charge.id}:${input.clientRequestId}`,
				actor: input.actor,
				reason: 'charge_refunded',
				now: ctx.now,
			})
			return {
				cardId: input.cardId,
				refundId: entry.id,
				balanceMinor: await giftCardBalance(tx, input.cardId),
			}
		},
	)
}

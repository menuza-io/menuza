import {
	GiftCardDomainError,
	giftCardRedeemableMinor,
} from '@repo/common/gift-cards'
import { type GiftCardCheckoutInput } from '@repo/common/gift-card-contract'
import {
	giftCardLedger,
	type GiftCardLedgerRow,
	type GiftCardRow,
} from '@repo/tenant-db'
import { and, eq, inArray } from 'drizzle-orm'
import { type GiftCardReader, type GiftCardTx } from '../lib/gift-card-write.ts'
import {
	redeemGiftCardInTx,
	refundGiftCardInTx,
} from './gift-card-service.ts'
import {
	assertGiftCardSpendable,
	findGiftCardByCode,
	getGiftCard,
	giftCardBalance,
} from './gift-card-store.ts'

/**
 * Where an order meets a gift card. A card is a tender: it takes at most its
 * balance and at most what is still to pay, after discounts and loyalty, and
 * the rest is paid online or at pickup. `total_cents` stays the whole order;
 * the card's part is `gift_card_cents` and the provider is charged the rest.
 * The redemption is booked in the order's own transaction (the order lock
 * is held), so a failed placement leaves the card untouched.
 */

export type OrderGiftCard = {
	card: GiftCardRow
	balanceMinor: number
	appliedMinor: number
	/** What is still to pay after the card. */
	dueMinor: number
}

/** The card the request names, by code or by a card saved to the customer's account. */
async function resolveCard(
	db: GiftCardReader,
	input: GiftCardCheckoutInput,
	customerId: string | null,
): Promise<GiftCardRow> {
	if (input.savedCardId) {
		const card = await getGiftCard(db, input.savedCardId)
		if (!card || !customerId || card.holderCustomerId !== customerId) {
			throw new GiftCardDomainError('code_invalid')
		}
		return card
	}
	if (!input.code) throw new GiftCardDomainError('invalid_request')
	const card = await findGiftCardByCode(db, input.code)
	if (!card || card.status === 'pending') {
		throw new GiftCardDomainError('code_invalid')
	}
	return card
}

/**
 * What a card would take off an order now (a read, for the quote and for
 * placement). Throws the precise refusal for a card that cannot be spent, in
 * another currency, or empty. `expectedAmountMinor` is compared, never trusted:
 * a different amount is `gift_card_changed` with the fresh one.
 */
export async function prepareGiftCardForOrder(
	db: GiftCardReader,
	input: {
		giftCard: GiftCardCheckoutInput
		customerId: string | null
		totalMinor: number
		currency: string
		now: number
		/** Placement compares the amount the guest was shown; a quote only reports it. */
		enforceExpected: boolean
	},
): Promise<OrderGiftCard> {
	const card = await resolveCard(db, input.giftCard, input.customerId)
	if (card.currency !== input.currency) {
		throw new GiftCardDomainError('currency_mismatch')
	}
	assertGiftCardSpendable(card, input.now)
	const balanceMinor = await giftCardBalance(db, card.id)
	const appliedMinor = giftCardRedeemableMinor(balanceMinor, input.totalMinor)
	if (appliedMinor <= 0) {
		throw new GiftCardDomainError('gift_card_balance_low', { balanceMinor })
	}
	if (
		input.enforceExpected &&
		input.giftCard.expectedAmountMinor !== appliedMinor
	) {
		throw new GiftCardDomainError('gift_card_changed', {
			appliedMinor,
			balanceMinor,
		})
	}
	return {
		card,
		balanceMinor,
		appliedMinor,
		dueMinor: input.totalMinor - appliedMinor,
	}
}

/** Books the redemption inside the order's transaction. */
export async function redeemOrderGiftCardInTx(
	tx: GiftCardTx,
	input: {
		gift: OrderGiftCard
		orderId: string
		locationId: string
		now: number
	},
): Promise<void> {
	await redeemGiftCardInTx(tx, {
		card: input.gift.card,
		amountMinor: input.gift.appliedMinor,
		sourceType: 'restaurant_order',
		sourceId: input.orderId,
		channel: 'online',
		locationId: input.locationId,
		idempotencyKey: `redeem:order:${input.orderId}`,
		now: input.now,
	})
}

export type OrderGiftShare = {
	redeemEntry: GiftCardLedgerRow | null
	redeemedMinor: number
	refundedMinor: number
	/** What the card can still be given back for this order. */
	remainingMinor: number
}

/** What an order took from a card and what already went back. */
export async function giftShareOfOrder(
	tx: GiftCardReader,
	orderId: string,
): Promise<OrderGiftShare> {
	const rows = await tx
		.select()
		.from(giftCardLedger)
		.where(
			and(
				eq(giftCardLedger.sourceType, 'restaurant_order'),
				eq(giftCardLedger.sourceId, orderId),
				inArray(giftCardLedger.kind, ['redeem', 'refund']),
			),
		)
	const redeem = rows.find((row) => row.kind === 'redeem') ?? null
	const redeemedMinor = redeem ? -redeem.amountMinor : 0
	const refundedMinor = rows
		.filter((row) => row.kind === 'refund')
		.reduce((sum, row) => sum + row.amountMinor, 0)
	return {
		redeemEntry: redeem,
		redeemedMinor,
		refundedMinor,
		remainingMinor: Math.max(0, redeemedMinor - refundedMinor),
	}
}

/**
 * Gives the card back up to `wantMinor` of what the order took (never more
 * than that redemption took). Returns what went back. Safe to repeat with the
 * same key: a second call returns the first call's amount.
 */
export async function refundGiftShareInTx(
	tx: GiftCardTx,
	input: {
		orderId: string
		wantMinor: number
		key: string
		reason: string
		actorId?: string | null
		now: number
	},
): Promise<number> {
	const idempotencyKey = `refund:order:${input.orderId}:${input.key}`
	const prior = await tx
		.select()
		.from(giftCardLedger)
		.where(eq(giftCardLedger.idempotencyKey, idempotencyKey))
		.get()
	if (prior) return prior.amountMinor
	const share = await giftShareOfOrder(tx, input.orderId)
	const amount = Math.min(input.wantMinor, share.remainingMinor)
	if (amount <= 0 || !share.redeemEntry) return 0
	const { entry } = await refundGiftCardInTx(tx, {
		redeemEntryId: share.redeemEntry.id,
		amountMinor: amount,
		idempotencyKey,
		actor: input.actorId ? { id: input.actorId, name: null } : null,
		reason: input.reason,
		now: input.now,
	})
	return entry.amountMinor
}

/**
 * An order that never captured provider money (unpaid and cancelled, expired,
 * failed, or paid entirely by card and cancelled) gives the whole card amount
 * back. Idempotent: what already went back is not given twice.
 */
export async function restoreOrderGiftCardsInTx(
	tx: GiftCardTx,
	orderIds: readonly string[],
	now: number,
	reason = 'order not completed',
): Promise<void> {
	for (const orderId of orderIds) {
		const share = await giftShareOfOrder(tx, orderId)
		if (share.remainingMinor <= 0) continue
		await refundGiftShareInTx(tx, {
			orderId,
			wantMinor: share.remainingMinor,
			key: 'restore',
			reason,
			now,
		})
	}
}

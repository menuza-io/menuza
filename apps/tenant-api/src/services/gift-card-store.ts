import {
	GiftCardDomainError,
	effectiveGiftCardStatus,
	giftCardLedgerSignOk,
	normalizeExternalCardNumber,
	normalizeGiftCardCode,
	visibleGiftCardBalance,
	type GiftCardChannel,
	type GiftCardLedgerKind,
	type GiftCardSourceType,
	type GiftCardStatus,
} from '@repo/common/gift-cards'
import {
	giftCardLedger,
	giftCards,
	type GiftCardLedgerRow,
	type GiftCardRow,
} from '@repo/tenant-db'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import {
	giftCardCodeHash,
	giftCardExternalHash,
} from '../lib/gift-card-secret.ts'
import { type GiftCardReader, type GiftCardTx } from '../lib/gift-card-write.ts'

/**
 * The primitives every gift-card operation shares: finding a card by what a
 * person typed, the balance (the sum of the ledger, never a stored number),
 * and appending a ledger entry. The balance is read and written in the same
 * transaction under the organization lock, and a trigger on the ledger
 * refuses an entry that would take it below zero, so concurrent redemptions
 * can never spend more than the card holds.
 */

export type GiftCardActor = {
	id: string | null
	name: string | null
}

/** A card by what a person typed or scanned: the Menuza code, then an original number. */
export async function findGiftCardByCode(
	db: GiftCardReader,
	raw: unknown,
): Promise<GiftCardRow | null> {
	const normalized = normalizeGiftCardCode(raw)
	const external = normalizeExternalCardNumber(raw)
	if (normalized) {
		const card = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.codeHash, giftCardCodeHash(normalized)))
			.get()
		if (card) return card
	}
	if (external) {
		const card = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.externalNumberHash, giftCardExternalHash(external)))
			.get()
		if (card) return card
	}
	return null
}

export async function getGiftCard(
	db: GiftCardReader,
	id: string,
): Promise<GiftCardRow | null> {
	return (
		(await db.select().from(giftCards).where(eq(giftCards.id, id)).get()) ?? null
	)
}

export async function giftCardBalance(
	db: GiftCardReader,
	cardId: string,
): Promise<number> {
	const row = await db
		.select({
			total: sql<number>`coalesce(sum(${giftCardLedger.amountMinor}), 0)`,
		})
		.from(giftCardLedger)
		.where(eq(giftCardLedger.cardId, cardId))
		.get()
	return Number(row?.total ?? 0)
}

/** Balances for many cards in as many statements as the parameter cap needs. */
export async function giftCardBalances(
	db: GiftCardReader,
	cardIds: readonly string[],
): Promise<Map<string, number>> {
	const rows = await queryInChunks(cardIds, (chunk) =>
		db
			.select({
				cardId: giftCardLedger.cardId,
				total: sql<number>`coalesce(sum(${giftCardLedger.amountMinor}), 0)`,
			})
			.from(giftCardLedger)
			.where(inArray(giftCardLedger.cardId, chunk))
			.groupBy(giftCardLedger.cardId),
	)
	const map = new Map<string, number>()
	for (const id of cardIds) map.set(id, 0)
	for (const row of rows) map.set(row.cardId, Number(row.total))
	return map
}

export function cardStatusNow(card: GiftCardRow, now: number): GiftCardStatus {
	return effectiveGiftCardStatus(card, now)
}

/**
 * Throws the precise error for a card that cannot be spent right now:
 * `gift_card_inactive` ("This card has not been activated"), `gift_card_held`,
 * `gift_card_frozen`, `gift_card_voided`, `gift_card_expired` or
 * `gift_card_not_active` (an unpaid online purchase).
 */
export function assertGiftCardSpendable(card: GiftCardRow, now: number): void {
	const status = cardStatusNow(card, now)
	switch (status) {
		case 'active':
			return
		case 'inactive':
			throw new GiftCardDomainError('gift_card_inactive')
		case 'held':
			throw new GiftCardDomainError('gift_card_held')
		case 'frozen':
			throw new GiftCardDomainError('gift_card_frozen')
		case 'voided':
			throw new GiftCardDomainError('gift_card_voided')
		case 'expired':
			throw new GiftCardDomainError('gift_card_expired')
		case 'pending':
			throw new GiftCardDomainError('gift_card_not_active')
	}
}

export type AppendEntryInput = {
	cardId: string
	kind: GiftCardLedgerKind
	amountMinor: number
	sourceType: GiftCardSourceType
	sourceId?: string | null
	channel: GiftCardChannel
	locationId?: string | null
	actor?: GiftCardActor | null
	reason?: string | null
	note?: string | null
	refEntryId?: string | null
	/** One fact, one entry: a replay of the same key finds the first entry. */
	idempotencyKey: string
	at: number
}

/**
 * Appends one ledger entry (inside a card write). A key already used returns
 * the earlier entry unchanged; a second `redeem` past the balance is refused
 * by the ledger trigger (mapped to `gift_card_balance_low`).
 */
export async function appendGiftCardEntry(
	tx: GiftCardTx,
	input: AppendEntryInput,
): Promise<{ entry: GiftCardLedgerRow; replayed: boolean }> {
	if (
		!Number.isSafeInteger(input.amountMinor) ||
		!giftCardLedgerSignOk(input.kind, input.amountMinor)
	) {
		throw new GiftCardDomainError('invalid_request')
	}
	const existing = await tx
		.select()
		.from(giftCardLedger)
		.where(eq(giftCardLedger.idempotencyKey, input.idempotencyKey))
		.get()
	if (existing) {
		if (
			existing.cardId !== input.cardId ||
			existing.kind !== input.kind ||
			existing.amountMinor !== input.amountMinor
		) {
			throw new GiftCardDomainError('idempotency_conflict')
		}
		return { entry: existing, replayed: true }
	}
	const [entry] = await tx
		.insert(giftCardLedger)
		.values({
			cardId: input.cardId,
			kind: input.kind,
			amountMinor: input.amountMinor,
			sourceType: input.sourceType,
			sourceId: input.sourceId ?? null,
			channel: input.channel,
			locationId: input.locationId ?? null,
			actorId: input.actor?.id ?? null,
			actorName: input.actor?.name ?? null,
			reason: input.reason ?? null,
			note: input.note ?? null,
			refEntryId: input.refEntryId ?? null,
			idempotencyKey: input.idempotencyKey,
			at: input.at,
		})
		.returning()
	if (input.kind === 'redeem') {
		await tx
			.update(giftCards)
			.set({ lastUsedAt: input.at, updatedAt: input.at })
			.where(eq(giftCards.id, input.cardId))
	}
	return { entry: entry!, replayed: false }
}

/** What a guest sees of a card: never an error for a card that exists. */
export type GiftCardGuestView = {
	id: string
	last4: string
	status: GiftCardStatus
	balanceMinor: number
	currency: string
	expiresAt: number | null
	/** `being_prepared` for a held purchase; nothing else is explained. */
	note: 'being_prepared' | null
}

export function guestViewOf(
	card: GiftCardRow,
	balanceMinor: number,
	now: number,
): GiftCardGuestView {
	const status = cardStatusNow(card, now)
	// A frozen or held (review) card reads as "being prepared"; the guest is
	// never told why (a disputed purchase is not announced to the buyer).
	const prepared = status === 'held' || status === 'frozen'
	return {
		id: card.id,
		last4: card.last4,
		status: prepared ? 'held' : status,
		balanceMinor: visibleGiftCardBalance(
			prepared ? 'active' : status,
			balanceMinor,
		),
		currency: card.currency,
		expiresAt: card.expiresAt,
		note: prepared ? 'being_prepared' : null,
	}
}

export type GiftCardHistoryEntry = {
	id: string
	kind: GiftCardLedgerKind
	amountMinor: number
	sourceType: GiftCardSourceType
	sourceId: string | null
	channel: GiftCardChannel
	locationId: string | null
	actorName: string | null
	reason: string | null
	note: string | null
	refEntryId: string | null
	at: number
}

export function historyEntryOf(row: GiftCardLedgerRow): GiftCardHistoryEntry {
	return {
		id: row.id,
		kind: row.kind,
		amountMinor: row.amountMinor,
		sourceType: row.sourceType,
		sourceId: row.sourceId,
		channel: row.channel,
		locationId: row.locationId,
		actorName: row.actorName,
		reason: row.reason,
		note: row.note,
		refEntryId: row.refEntryId,
		at: row.at,
	}
}

export async function giftCardHistory(
	db: GiftCardReader,
	cardId: string,
	limit = 200,
): Promise<GiftCardHistoryEntry[]> {
	const rows = await db
		.select()
		.from(giftCardLedger)
		.where(eq(giftCardLedger.cardId, cardId))
		.orderBy(asc(giftCardLedger.at), asc(giftCardLedger.id))
		.limit(limit)
	return rows.map(historyEntryOf)
}

/** The most recent ledger entries of a card, newest first (guest wallet). */
export async function recentGiftCardEntries(
	db: GiftCardReader,
	cardId: string,
	limit = 10,
): Promise<GiftCardHistoryEntry[]> {
	const rows = await db
		.select()
		.from(giftCardLedger)
		.where(eq(giftCardLedger.cardId, cardId))
		.orderBy(desc(giftCardLedger.at), desc(giftCardLedger.id))
		.limit(limit)
	return rows.map(historyEntryOf)
}

/** The sum of what one source redeemed from a card and what came back. */
export async function redeemedForSource(
	db: GiftCardReader,
	sourceType: GiftCardSourceType,
	sourceId: string,
): Promise<{ redeemedMinor: number; refundedMinor: number }> {
	const rows = await db
		.select({
			kind: giftCardLedger.kind,
			total: sql<number>`coalesce(sum(${giftCardLedger.amountMinor}), 0)`,
		})
		.from(giftCardLedger)
		.where(
			and(
				eq(giftCardLedger.sourceType, sourceType),
				eq(giftCardLedger.sourceId, sourceId),
				inArray(giftCardLedger.kind, ['redeem', 'refund']),
			),
		)
		.groupBy(giftCardLedger.kind)
	let redeemed = 0
	let refunded = 0
	for (const row of rows) {
		if (row.kind === 'redeem') redeemed = -Number(row.total)
		else refunded = Number(row.total)
	}
	return { redeemedMinor: redeemed, refundedMinor: refunded }
}

import {
	GIFT_CARD_SHOW_TOKEN_TTL_MS,
	GiftCardDomainError,
} from '@repo/common/gift-cards'
import {
	customers,
	giftCardShowTokens,
	giftCards,
	getTenantDb,
	type GiftCardRow,
} from '@repo/tenant-db'
import { and, asc, eq, gt, isNull, lt } from 'drizzle-orm'
import {
	giftCardShowTokenHash,
	newShowToken,
} from '../lib/gift-card-secret.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { withGiftCardWrite, type GiftCardTx } from '../lib/gift-card-write.ts'
import {
	appendGiftCardEntry,
	findGiftCardByCode,
	getGiftCard,
	giftCardBalance,
	giftCardBalances,
	guestViewOf,
	recentGiftCardEntries,
	type GiftCardGuestView,
	type GiftCardHistoryEntry,
} from './gift-card-store.ts'

/**
 * The guest's own cards (#217): a card saved to an account is a convenience,
 * never a lock. The full code still spends it. A card sits in one account at a
 * time; saving it elsewhere needs the full code and tells the first account.
 * Erasing the person unlinks their cards and keeps every balance.
 */

export type SavedGiftCard = GiftCardGuestView & {
	savedAt: number | null
	recent: GiftCardHistoryEntry[]
}

/** Cards saved to this customer, newest first, with a short recent activity. */
export async function listSavedGiftCards(
	orgId: string,
	customerId: string,
	now = Date.now(),
): Promise<SavedGiftCard[]> {
	const db = await getTenantDb(orgId)
	const cards = await db
		.select()
		.from(giftCards)
		.where(eq(giftCards.holderCustomerId, customerId))
		.orderBy(asc(giftCards.heldAt))
		.limit(50)
	const balances = await giftCardBalances(
		db,
		cards.map((card) => card.id),
	)
	const out: SavedGiftCard[] = []
	for (const card of cards) {
		out.push({
			...guestViewOf(card, balances.get(card.id) ?? 0, now),
			savedAt: card.heldAt,
			recent: await recentGiftCardEntries(db, card.id, 5),
		})
	}
	return out
}

export type ClaimResult = {
	card: GiftCardGuestView
	/** The customer the card moved from, so they can be told. */
	movedFrom: string | null
	alreadyMine: boolean
}

/**
 * Saves a card to this customer's account by its full code. Moves it from
 * another account when there is one (the first holder is told by email when
 * they have one). A card that cannot be spent yet (printed, unpaid) is
 * refused as not found, as a wrong code is.
 */
export async function claimGiftCard(input: {
	orgId: string
	customerId: string
	code: string
	now?: number
}): Promise<ClaimResult> {
	let previousHolder: string | null = null
	const result = await withGiftCardWrite(
		{ orgId: input.orgId, now: input.now },
		async (tx, ctx) => {
			const card = await findGiftCardByCode(tx, input.code)
			if (!card || card.status === 'pending' || card.status === 'inactive') {
				throw new GiftCardDomainError('code_invalid')
			}
			ctx.linkCard(card.id)
			if (card.holderCustomerId === input.customerId) {
				return {
					card: guestViewOf(card, await giftCardBalance(tx, card.id), ctx.now),
					movedFrom: null,
					alreadyMine: true,
				}
			}
			previousHolder = card.holderCustomerId
			await tx
				.update(giftCards)
				.set({
					holderCustomerId: input.customerId,
					heldAt: ctx.now,
					updatedAt: ctx.now,
				})
				.where(eq(giftCards.id, card.id))
			await appendGiftCardEntry(tx, {
				cardId: card.id,
				kind: 'event',
				amountMinor: 0,
				sourceType: 'system',
				channel: 'online',
				locationId: card.locationId,
				reason: previousHolder ? 'moved to another account' : 'saved to an account',
				idempotencyKey: `claim:${card.id}:${input.customerId}:${ctx.now}`,
				at: ctx.now,
			})
			const fresh = await getGiftCard(tx, card.id)
			return {
				card: guestViewOf(fresh!, await giftCardBalance(tx, card.id), ctx.now),
				movedFrom: previousHolder,
				alreadyMine: false,
			}
		},
	)
	if (result.movedFrom) {
		void notifyPreviousHolder(input.orgId, result.movedFrom, result.card.last4).catch(
			() => undefined,
		)
	}
	return result
}

async function notifyPreviousHolder(
	orgId: string,
	customerId: string,
	last4: string,
): Promise<void> {
	const db = await getTenantDb(orgId)
	const holder = await db
		.select({ email: customers.email })
		.from(customers)
		.where(eq(customers.id, customerId))
		.get()
	if (!holder?.email) return
	const context = await getReservationsContext(orgId).catch(() => null)
	const name = context?.organization.name ?? ''
	// A short plain notice: the card ending in `last4` was saved to another account.
	await sendTenantEmail({
		to: holder.email,
		subject: name ? `A gift card was saved to another account (${name})` : 'A gift card was saved to another account',
		html: `<p>A gift card ending in ${last4.replace(/[^A-Z0-9]/gi, '')} was saved to another account. If this was not you, you can still use the card with its code.</p>`,
		text: `A gift card ending in ${last4.replace(/[^A-Z0-9]/gi, '')} was saved to another account. If this was not you, you can still use the card with its code.`,
		capture: { orgId, messageKind: 'gift_card_moved', messageId: `${customerId}:${last4}` },
	})
}

/** Marks a card as the customer's own at purchase (bought for themselves). */
export async function saveToPurchaser(
	tx: GiftCardTx,
	card: GiftCardRow,
	now: number,
): Promise<void> {
	if (!card.purchaserCustomerId || !card.sendToSelf || card.holderCustomerId) return
	await tx
		.update(giftCards)
		.set({ holderCustomerId: card.purchaserCustomerId, heldAt: now, updatedAt: now })
		.where(and(eq(giftCards.id, card.id), isNull(giftCards.holderCustomerId)))
}

/**
 * A one-use QR token for the till, short-lived and not the card code. Only
 * the holder gets one, and each new token supersedes the older ones.
 */
export async function createShowToken(input: {
	orgId: string
	customerId: string
	cardId: string
	now?: number
}): Promise<{ token: string; expiresAt: number }> {
	return withGiftCardWrite({ orgId: input.orgId, now: input.now }, async (tx, ctx) => {
		const card = await getGiftCard(tx, input.cardId)
		if (!card || card.holderCustomerId !== input.customerId) {
			throw new GiftCardDomainError('not_found')
		}
		await tx.delete(giftCardShowTokens).where(lt(giftCardShowTokens.expiresAt, ctx.now))
		await tx
			.update(giftCardShowTokens)
			.set({ usedAt: ctx.now })
			.where(
				and(eq(giftCardShowTokens.cardId, card.id), isNull(giftCardShowTokens.usedAt)),
			)
		const token = newShowToken()
		const expiresAt = ctx.now + GIFT_CARD_SHOW_TOKEN_TTL_MS
		await tx.insert(giftCardShowTokens).values({
			tokenHash: giftCardShowTokenHash(token),
			cardId: card.id,
			customerId: input.customerId,
			expiresAt,
			createdAt: ctx.now,
		})
		return { token, expiresAt }
	})
}

/**
 * Spends a show token inside a write (the till): single use, expired is
 * refused. Returns the card it names, or throws `code_invalid`.
 */
export async function consumeShowTokenInTx(
	tx: GiftCardTx,
	token: string,
	now: number,
): Promise<GiftCardRow> {
	const row = await tx
		.update(giftCardShowTokens)
		.set({ usedAt: now })
		.where(
			and(
				eq(giftCardShowTokens.tokenHash, giftCardShowTokenHash(token)),
				isNull(giftCardShowTokens.usedAt),
				gt(giftCardShowTokens.expiresAt, now),
			),
		)
		.returning({ cardId: giftCardShowTokens.cardId })
	const cardId = row[0]?.cardId
	if (!cardId) throw new GiftCardDomainError('code_invalid')
	const card = await getGiftCard(tx, cardId)
	if (!card) throw new GiftCardDomainError('code_invalid')
	return card
}

/** Reads a show token without spending it (the till's lookup before the redeem). */
export async function peekShowToken(
	db: GiftCardTx | Awaited<ReturnType<typeof getTenantDb>>,
	token: string,
	now: number,
): Promise<GiftCardRow | null> {
	const row = await db
		.select({ cardId: giftCardShowTokens.cardId })
		.from(giftCardShowTokens)
		.where(
			and(
				eq(giftCardShowTokens.tokenHash, giftCardShowTokenHash(token)),
				isNull(giftCardShowTokens.usedAt),
				gt(giftCardShowTokens.expiresAt, now),
			),
		)
		.get()
	return row ? getGiftCard(db, row.cardId) : null
}

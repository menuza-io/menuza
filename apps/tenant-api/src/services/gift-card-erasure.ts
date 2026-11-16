import {
	giftCardIdempotencyKeys,
	giftCardLedger,
	giftCardPurchaseAttempts,
	giftCardShowTokens,
	giftCards,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { forEachInChunks, inJsonList } from '../lib/chunked-in.ts'
import { giftCardFingerprint } from '../lib/gift-card-secret.ts'

/**
 * The gift card part of person erasure. `erasePerson` calls it inside the same
 * regional transaction, before the customer rows are deleted.
 *
 * A card is the organization's money record, so it stays, with its ledger and
 * its balance: those no longer identify anyone. What goes is the person:
 *
 * - **holder**: a card saved to the erased account is unlinked;
 * - **purchaser** (the account, or a guest by email): the account link, name,
 *   email and the "from" name are removed. No receipt is attempted after that,
 *   and the note to the recipient goes once the card has been delivered (an
 *   undelivered card is still delivered, as the buyer paid for it);
 * - **recipient** (by email): name, email and the note are removed. An
 *   undelivered card is then not delivered (nobody to send it to); a manager
 *   can see it and refund the unspent balance;
 * - operator notes on the ledger entries of those cards (the only update the
 *   append-only trigger allows besides the actor's name);
 * - the person's till QR tokens, the stored idempotent responses of their cards
 *   and their purchase-limit fingerprints (keyed hashes).
 *
 * Every card it touches is stamped `erased_at`. The code hash, last four
 * characters, amounts and statuses stay: they are not a person's data.
 */

type Db = TenantDatabase | TenantTransaction
type GiftCardRow = typeof giftCards.$inferSelect

export async function eraseGiftCardsInTx(
	tx: Db,
	input: {
		customerIds: readonly string[]
		emails: readonly string[]
		now: number
	},
): Promise<{ cardsErased: number }> {
	const customerIds = [...new Set(input.customerIds)]
	const emails = [
		...new Set(
			input.emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
		),
	]
	if (customerIds.length === 0 && emails.length === 0) return { cardsErased: 0 }
	const customerSet = new Set(customerIds)
	const emailSet = new Set(emails)

	// The cards that name the person, by account or by (lower-cased) email. One
	// JSON list per side (a single bound parameter), so a long list of ids can
	// never reach the 100-parameter limit of a Durable Object statement.
	const found = new Map<string, GiftCardRow>()
	if (customerIds.length > 0) {
		const byAccount = await tx
			.select()
			.from(giftCards)
			.where(
				or(
					inJsonList(giftCards.holderCustomerId, customerIds),
					inJsonList(giftCards.purchaserCustomerId, customerIds),
				),
			)
			.all()
		for (const row of byAccount) found.set(row.id, row)
	}
	if (emails.length > 0) {
		const byEmail = await tx
			.select()
			.from(giftCards)
			.where(
				or(
					inJsonList(sql`lower(${giftCards.purchaserEmail})`, emails),
					inJsonList(sql`lower(${giftCards.recipientEmail})`, emails),
				),
			)
			.all()
		for (const row of byEmail) found.set(row.id, row)
	}

	for (const card of found.values()) {
		const holder =
			card.holderCustomerId !== null && customerSet.has(card.holderCustomerId)
		const purchaser =
			(card.purchaserCustomerId !== null &&
				customerSet.has(card.purchaserCustomerId)) ||
			(card.purchaserEmail !== null &&
				emailSet.has(card.purchaserEmail.toLowerCase()))
		const recipient =
			card.recipientEmail !== null &&
			emailSet.has(card.recipientEmail.toLowerCase())
		const patch: Partial<typeof giftCards.$inferInsert> = {
			erasedAt: card.erasedAt ?? input.now,
			updatedAt: input.now,
		}
		if (holder) {
			patch.holderCustomerId = null
			patch.heldAt = null
		}
		if (purchaser) {
			patch.purchaserCustomerId = null
			patch.purchaserName = null
			patch.purchaserEmail = null
			patch.senderName = null
			// Nobody left to send a receipt to: stop the tick trying.
			if (card.receiptSentAt === null) patch.receiptSentAt = input.now
			// The note is the recipient's to read once the card has been delivered.
			if (card.deliveredAt !== null) patch.message = null
		}
		if (recipient) {
			patch.recipientName = null
			patch.recipientEmail = null
			patch.message = null
		}
		await tx.update(giftCards).set(patch).where(eq(giftCards.id, card.id))
	}

	const cardIds = [...found.keys()]
	// Operator notes may name the person; the amounts and kinds stay.
	await forEachInChunks(cardIds, (chunk) =>
		tx
			.update(giftCardLedger)
			.set({ note: null })
			.where(
				and(
					inArray(giftCardLedger.cardId, chunk),
					isNotNull(giftCardLedger.note),
				),
			),
	)
	// Stored idempotent responses of those cards (and, below, the person's QR
	// tokens and limit fingerprints).
	await forEachInChunks(cardIds, async (chunk) => {
		await tx
			.delete(giftCardIdempotencyKeys)
			.where(inArray(giftCardIdempotencyKeys.cardId, chunk))
		await tx
			.delete(giftCardPurchaseAttempts)
			.where(inArray(giftCardPurchaseAttempts.cardId, chunk))
	})
	await forEachInChunks(customerIds, (chunk) =>
		tx
			.delete(giftCardShowTokens)
			.where(inArray(giftCardShowTokens.customerId, chunk)),
	)
	// A purchase by this email under any card, hashed the way the limits do.
	await forEachInChunks(
		emails.map((email) => giftCardFingerprint('email', email)),
		(chunk) =>
			tx
				.delete(giftCardPurchaseAttempts)
				.where(inArray(giftCardPurchaseAttempts.emailHash, chunk)),
	)
	return { cardsErased: found.size }
}

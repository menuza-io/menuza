import { type GiftCardDesignKey } from '@repo/common/gift-cards'
import { getTenantDb, giftCards, type GiftCardRow } from '@repo/tenant-db'
import { and, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { renderGiftCardEmail } from '../lib/gift-card-email.ts'
import { postGiftCardNotify } from '../lib/gift-card-notify.ts'
import { openGiftCardCode } from '../lib/gift-card-secret.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { getGiftCardFlagState } from '../lib/gift-card-context.ts'
import { giftCardBalance } from './gift-card-store.ts'

/**
 * Sends the buyer's receipt (once the purchase is paid) and the recipient's
 * card (once it is due and the card is active). Driven by what is in the
 * table, not a queue: each send is claimed with a compare-and-set on the
 * attempt counter, so a tick racing the paid event cannot send twice, and a
 * failed send is retried by the tick up to a limit. The code is read from its
 * seal only for the send, and the seal is cleared once the card has gone out.
 * Texts carry no code. No email is ever sent for an imported or till-sold card.
 */

export const GIFT_CARD_MAX_DELIVERY_ATTEMPTS = 6

export type GiftCardMessageTotals = {
	delivered: number
	failed: number
	receipts: number
}

function safeUrlJoin(origin: string | null, path: string): string | null {
	if (!origin) return null
	try {
		return new URL(path, origin).toString()
	} catch {
		return null
	}
}

function imageUrlFor(
	origin: string | null,
	key: string | null | undefined,
): string | null {
	if (!key) return null
	if (/^https?:\/\//.test(key)) return key
	return safeUrlJoin(origin, key.startsWith('/') ? key : `/${key}`)
}

export async function sendGiftCardMessages(
	orgId: string,
	options: { cardId?: string; now?: number } = {},
): Promise<GiftCardMessageTotals> {
	const now = options.now ?? Date.now()
	const totals: GiftCardMessageTotals = { delivered: 0, failed: 0, receipts: 0 }
	const db = await getTenantDb(orgId)
	const context = await getReservationsContext(orgId).catch(() => null)
	const flags = await getGiftCardFlagState(orgId)
	const origin = context?.organization.siteOrigin ?? null
	const restaurantName =
		context?.organization.emailTheme.organizationName ||
		context?.organization.name ||
		''
	const theme = context?.organization.emailTheme ?? null

	const scope = options.cardId ? eq(giftCards.id, options.cardId) : undefined
	const receipts = await db
		.select()
		.from(giftCards)
		.where(
			and(
				scope,
				eq(giftCards.source, 'online'),
				eq(giftCards.paymentStatus, 'paid'),
				isNull(giftCards.receiptSentAt),
				isNotNull(giftCards.purchaserEmail),
			),
		)
		.limit(100)
	for (const card of receipts) {
		const claimed = await db
			.update(giftCards)
			.set({ receiptSentAt: now })
			.where(and(eq(giftCards.id, card.id), isNull(giftCards.receiptSentAt)))
			.returning({ id: giftCards.id })
		if (claimed.length === 0) continue
		const timing: 'now' | 'later' | 'held' =
			card.status === 'held'
				? 'held'
				: card.deliverAt && card.deliverAt > now + 5 * 60_000
					? 'later'
					: 'now'
		const rendered = renderGiftCardEmail({
			kind: 'receipt',
			locale: card.locale ?? context?.organization.defaultLocale ?? 'en',
			theme,
			restaurantName,
			designKey: card.designKey as GiftCardDesignKey | null,
			amountMinor: card.purchaseAmountMinor ?? 0,
			currency: card.currency,
			feeMinor: card.feeMinor,
			recipientName: card.recipientName,
			sendToSelf: card.sendToSelf,
			timing,
			deliverAt: card.deliverAt,
			timeZone: zoneFor(context, card),
			balanceUrl: safeUrlJoin(origin, '/gift-cards/balance'),
		})
		const sent = await sendTenantEmail({
			to: card.purchaserEmail!,
			subject: rendered.subject,
			html: rendered.html,
			text: rendered.text,
			capture: { orgId, messageKind: 'gift_card_receipt', messageId: card.id },
		}).catch(() => ({ status: 'error' as const }))
		if (sent.status === 'error') {
			// Let the next pass try again.
			await db
				.update(giftCards)
				.set({ receiptSentAt: null })
				.where(eq(giftCards.id, card.id))
		} else {
			totals.receipts += 1
		}
	}

	const due = await db
		.select()
		.from(giftCards)
		.where(
			and(
				scope,
				eq(giftCards.source, 'online'),
				eq(giftCards.status, 'active'),
				isNull(giftCards.deliveredAt),
				isNotNull(giftCards.sealedCode),
				isNotNull(giftCards.recipientEmail),
				or(isNull(giftCards.deliverAt), lte(giftCards.deliverAt, now)),
				sql`${giftCards.deliveryAttempts} < ${GIFT_CARD_MAX_DELIVERY_ATTEMPTS}`,
			),
		)
		.limit(100)
	for (const card of due) {
		const claimed = await db
			.update(giftCards)
			.set({ deliveryAttempts: card.deliveryAttempts + 1 })
			.where(
				and(
					eq(giftCards.id, card.id),
					isNull(giftCards.deliveredAt),
					eq(giftCards.deliveryAttempts, card.deliveryAttempts),
				),
			)
			.returning({ id: giftCards.id })
		if (claimed.length === 0) continue
		const code = card.sealedCode ? openGiftCardCode(card.sealedCode) : null
		if (!code) {
			totals.failed += 1
			continue
		}
		const balance = await giftCardBalance(db, card.id)
		const settings = flags.settings
		const customDesign = settings.designs.find((d) => d.key === 'custom')
		const rendered = renderGiftCardEmail({
			kind: 'delivery',
			locale: card.locale ?? context?.organization.defaultLocale ?? 'en',
			theme,
			restaurantName,
			designKey: card.designKey as GiftCardDesignKey | null,
			designImageUrl: imageUrlFor(origin, customDesign?.imageKey),
			amountMinor: balance,
			currency: card.currency,
			code,
			senderName: card.senderName ?? card.purchaserName,
			recipientName: card.recipientName,
			message: card.message,
			sendToSelf: card.sendToSelf,
			expiresAt: card.expiresAt,
			timeZone: zoneFor(context, card),
			balanceUrl: safeUrlJoin(origin, '/gift-cards/balance'),
			orderUrl: safeUrlJoin(origin, '/menu'),
			// The code rides in the fragment: it never reaches a server log.
			addToAccountUrl: safeUrlJoin(origin, `/profile/gift-cards#add=${code}`),
		})
		const sent = await sendTenantEmail({
			to: card.recipientEmail!,
			subject: rendered.subject,
			html: rendered.html,
			text: rendered.text,
			capture: { orgId, messageKind: 'gift_card_delivery', messageId: card.id },
		}).catch(() => ({ status: 'error' as const }))
		if (sent.status === 'error') {
			totals.failed += 1
			if (card.deliveryAttempts + 1 >= GIFT_CARD_MAX_DELIVERY_ATTEMPTS) {
				void postGiftCardNotify({ orgId, kind: 'delivery_failed', count: 1 })
			}
			continue
		}
		await db
			.update(giftCards)
			.set({ deliveredAt: now, sealedCode: null, updatedAt: now })
			.where(eq(giftCards.id, card.id))
		totals.delivered += 1
	}
	return totals
}

function zoneFor(
	context: Awaited<ReturnType<typeof getReservationsContext>> | null,
	card: GiftCardRow,
): string | null {
	const location = context?.locations.find((l) => l.id === card.locationId)
	return location?.timeZone ?? null
}

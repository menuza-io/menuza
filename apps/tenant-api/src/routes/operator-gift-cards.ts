import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
	GIFT_CARD_PERMISSIONS,
	GIFT_CARD_STATUSES,
	GiftCardDomainError,
	effectiveGiftCardStatus,
} from '@repo/common/gift-cards'
import { getTenantDb, giftCards, type GiftCardRow } from '@repo/tenant-db'
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import { giftCardLocationAllowed } from '../lib/gift-card-auth.ts'
import { getGiftCardAuth, giftCardGuard } from '../lib/gift-card-guard.ts'
import {
	giftCardDeny,
	giftCardErrorResponse,
	giftCardIdempotency,
} from '../lib/gift-card-http.ts'
import {
	chargeGiftCardGuess,
	settleGiftCardGuess,
} from '../lib/gift-card-rate-limit.ts'
import { readJsonBody, readQuery } from '../lib/http.ts'
import {
	adjustGiftCard,
	chargeGiftCard,
	refundGiftCardCharge,
	voidGiftCard,
} from '../services/gift-card-service.ts'
import {
	approveHeldGiftCard,
	bookGiftCardPurchaseRefund,
} from '../services/gift-card-purchase-service.ts'
import {
	findGiftCardByCode,
	getGiftCard,
	giftCardBalance,
	giftCardBalances,
	giftCardHistory,
	type GiftCardActor,
} from '../services/gift-card-store.ts'

/**
 * Operator gift-card routes (`/operator/gift-cards/*`, browser-direct with the
 * App-minted `gft+jwt`). List and detail need `read:gift_card:any`; adjusting,
 * voiding, review and refunds need `update:gift_card:any`; charging a card
 * from the App needs `update:gift_card_charge:any` so a manager can take a
 * payment without being able to adjust balances freely. An impersonated token
 * can change nothing. Responses are `private, no-store`.
 */
export const operatorGiftCardRoutes = new Hono()

const READ = giftCardGuard({
	scope: ['read', 'write'],
	grant: GIFT_CARD_PERMISSIONS.READ_GIFT_CARD,
	readOnly: true,
})
const UPDATE = giftCardGuard({
	scope: 'write',
	grant: GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD,
})
const CHARGE = giftCardGuard({
	scope: 'write',
	grant: GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD_CHARGE,
})

function actorOf(c: Context): GiftCardActor {
	const auth = getGiftCardAuth(c)
	return { id: auth.userId, name: auth.actorName }
}

export type OperatorGiftCardView = {
	id: string
	last4: string
	externalLast4: string | null
	status: (typeof GIFT_CARD_STATUSES)[number]
	balanceMinor: number
	currency: string
	source: GiftCardRow['source']
	locationId: string | null
	batchId: string | null
	designKey: string | null
	createdAt: number
	activatedAt: number | null
	lastUsedAt: number | null
	expiresAt: number | null
	holdReason: GiftCardRow['holdReason']
	holdUntil: number | null
	freezeReason: string | null
	paymentStatus: GiftCardRow['paymentStatus']
	purchaseAmountMinor: number | null
	imported: boolean
}

export function operatorViewOf(
	card: GiftCardRow,
	balanceMinor: number,
	now: number,
): OperatorGiftCardView {
	return {
		id: card.id,
		last4: card.last4,
		externalLast4: card.externalLast4,
		status: effectiveGiftCardStatus(card, now),
		balanceMinor,
		currency: card.currency,
		source: card.source,
		locationId: card.locationId,
		batchId: card.batchId,
		designKey: card.designKey,
		createdAt: card.createdAt,
		activatedAt: card.activatedAt,
		lastUsedAt: card.lastUsedAt,
		expiresAt: card.expiresAt,
		holdReason: card.holdReason,
		holdUntil: card.holdUntil,
		freezeReason: card.freezeReason,
		paymentStatus: card.paymentStatus,
		purchaseAmountMinor: card.purchaseAmountMinor,
		imported: card.source === 'import',
	}
}

const listQuerySchema = z.object({
	status: z.enum(GIFT_CARD_STATUSES).optional(),
	/** The last four characters of a card (printed number or Menuza code). */
	last4: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9]{1,4}$/)
		.optional(),
	needsReview: z.enum(['true', 'false']).optional(),
	locationId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/)
		.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	/** Created before this time (ms): the cursor of the last row seen. */
	before: z.coerce.number().int().positive().optional(),
})

/** Cards the token may see: all, or those of its locations. */
function scopeCondition(
	locationIds: readonly string[] | null,
): SQL | undefined {
	if (locationIds === null) return undefined
	if (locationIds.length === 0) return sql`0`
	return inArray(giftCards.locationId, [...locationIds])
}

operatorGiftCardRoutes.get('/', READ, async (c) => {
	const query = readQuery(c, listQuerySchema)
	if ('error' in query) return query.error
	const auth = getGiftCardAuth(c)
	const q = query.data
	const db = await getTenantDb(auth.orgId)
	const needsReview = q.needsReview === 'true'
	const rows = await db
		.select()
		.from(giftCards)
		.where(
			and(
				// Unpaid purchases that never started are noise, not cards.
				sql`${giftCards.status} <> 'pending' or ${giftCards.paymentStatus} = 'review'`,
				scopeCondition(auth.locationIds),
				q.status ? eq(giftCards.status, q.status) : undefined,
				q.last4
					? or(
							eq(giftCards.last4, q.last4.toUpperCase()),
							eq(giftCards.externalLast4, q.last4),
						)
					: undefined,
				q.locationId ? eq(giftCards.locationId, q.locationId) : undefined,
				needsReview
					? or(
							and(
								eq(giftCards.status, 'held'),
								inArray(giftCards.holdReason, ['provider_risk', 'manual']),
							),
							eq(giftCards.paymentStatus, 'review'),
						)
					: undefined,
				q.before ? lt(giftCards.createdAt, q.before) : undefined,
			),
		)
		.orderBy(desc(giftCards.createdAt), desc(giftCards.id))
		.limit(q.limit + 1)
	const page = rows.slice(0, q.limit)
	const balances = await giftCardBalances(
		db,
		page.map((card) => card.id),
	)
	const now = Date.now()
	return giftCardDeny(200, 'ok', {
		cards: page.map((card) => operatorViewOf(card, balances.get(card.id) ?? 0, now)),
		next: rows.length > q.limit ? page[page.length - 1]!.createdAt : null,
	})
})

/** Finds one card by its number (the Charge card dialog); guesses are limited. */
operatorGiftCardRoutes.post('/lookup', READ, async (c) => {
	const body = await readJsonBody(
		c,
		z.strictObject({ code: z.string().trim().min(8).max(64) }),
	)
	if ('error' in body) return body.error
	const auth = getGiftCardAuth(c)
	try {
		const db = await getTenantDb(auth.orgId)
		const charge = await chargeGiftCardGuess(db, {
			orgId: auth.orgId,
			subject: { kind: 'customer', customerId: `op:${auth.userId}`, address: null },
		})
		const card = await findGiftCardByCode(db, body.data.code)
		const visible =
			card &&
			card.status !== 'pending' &&
			giftCardLocationAllowed(auth, card.locationId)
		await settleGiftCardGuess(db, charge, visible ? 'right' : 'wrong')
		if (!card || !visible) throw new GiftCardDomainError('code_invalid')
		return giftCardDeny(
			200,
			'ok',
			operatorViewOf(card, await giftCardBalance(db, card.id), Date.now()),
		)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

async function cardFor(c: Context) {
	const auth = getGiftCardAuth(c)
	const db = await getTenantDb(auth.orgId)
	const card = await getGiftCard(db, c.req.param('id') ?? '')
	if (!card || card.status === 'pending') {
		return { error: giftCardDeny(404, 'not_found') }
	}
	if (!giftCardLocationAllowed(auth, card.locationId)) {
		return { error: giftCardDeny(403, 'location_forbidden') }
	}
	return { auth, db, card }
}

operatorGiftCardRoutes.get('/:id', READ, async (c) => {
	const found = await cardFor(c)
	if ('error' in found) return found.error
	const { db, card } = found
	const balance = await giftCardBalance(db, card.id)
	const history = await giftCardHistory(db, card.id)
	return giftCardDeny(200, 'ok', {
		card: operatorViewOf(card, balance, Date.now()),
		history,
		// Purchaser and recipient details stay in the region: the browser reads
		// them here and the App server never sees them.
		people: {
			purchaserName: card.purchaserName,
			purchaserEmail: card.purchaserEmail,
			recipientName: card.recipientName,
			recipientEmail: card.recipientEmail,
			senderName: card.senderName,
			message: card.message,
			deliverAt: card.deliverAt,
			deliveredAt: card.deliveredAt,
		},
		originalLast4: card.externalLast4,
	})
})

const adjustSchema = z.strictObject({
	expectedBalanceMinor: z.number().int().min(0),
	deltaMinor: z.number().int().min(-10_000_000).max(10_000_000),
	reason: z.string().trim().min(1).max(500),
})

operatorGiftCardRoutes.post('/:id/adjust', UPDATE, async (c) => {
	const body = await readJsonBody(c, adjustSchema)
	if ('error' in body) return body.error
	const found = await cardFor(c)
	if ('error' in found) return found.error
	const idem = giftCardIdempotency(c, `adjust:${found.card.id}`, body.data)
	if ('error' in idem) return idem.error
	try {
		const result = await adjustGiftCard({
			orgId: found.auth.orgId,
			cardId: found.card.id,
			actor: actorOf(c),
			idempotency: idem.idempotency,
			...body.data,
		})
		return giftCardDeny(200, 'ok', result)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

const voidSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) })

operatorGiftCardRoutes.post('/:id/void', UPDATE, async (c) => {
	const body = await readJsonBody(c, voidSchema)
	if ('error' in body) return body.error
	const found = await cardFor(c)
	if ('error' in found) return found.error
	const idem = giftCardIdempotency(c, `void:${found.card.id}`, body.data)
	if ('error' in idem) return idem.error
	try {
		const result = await voidGiftCard({
			orgId: found.auth.orgId,
			cardId: found.card.id,
			reason: body.data.reason,
			actor: actorOf(c),
			idempotency: idem.idempotency,
		})
		return giftCardDeny(200, 'ok', result)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

const chargeSchema = z.strictObject({
	amountMinor: z.number().int().min(1).max(10_000_000),
	note: z.string().trim().min(1).max(500),
	attachTo: z
		.strictObject({
			kind: z.enum(['restaurant_order', 'quote', 'payment_link']),
			id: z.string().min(1).max(100),
		})
		.nullable()
		.optional(),
	clientRequestId: z.string().min(8).max(100),
})

operatorGiftCardRoutes.post('/:id/charges', CHARGE, async (c) => {
	const body = await readJsonBody(c, chargeSchema)
	if ('error' in body) return body.error
	const found = await cardFor(c)
	if ('error' in found) return found.error
	const idem = giftCardIdempotency(c, `charge:${found.card.id}`, body.data)
	if ('error' in idem) return idem.error
	try {
		const result = await chargeGiftCard({
			orgId: found.auth.orgId,
			cardId: found.card.id,
			amountMinor: body.data.amountMinor,
			note: body.data.note,
			attachTo: body.data.attachTo ?? null,
			locationId: null,
			actor: actorOf(c),
			clientRequestId: body.data.clientRequestId,
			idempotency: idem.idempotency,
		})
		return giftCardDeny(200, 'ok', result)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

const refundChargeSchema = z.strictObject({
	amountMinor: z.number().int().min(1).max(10_000_000),
	clientRequestId: z.string().min(8).max(100),
})

operatorGiftCardRoutes.post('/:id/charges/:chargeId/refund', CHARGE, async (c) => {
	const body = await readJsonBody(c, refundChargeSchema)
	if ('error' in body) return body.error
	const found = await cardFor(c)
	if ('error' in found) return found.error
	const idem = giftCardIdempotency(
		c,
		`charge-refund:${found.card.id}:${c.req.param('chargeId')}`,
		body.data,
	)
	if ('error' in idem) return idem.error
	try {
		const result = await refundGiftCardCharge({
			orgId: found.auth.orgId,
			cardId: found.card.id,
			chargeId: c.req.param('chargeId') ?? '',
			amountMinor: body.data.amountMinor,
			clientRequestId: body.data.clientRequestId,
			actor: actorOf(c),
			idempotency: idem.idempotency,
		})
		return giftCardDeny(200, 'ok', result)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

/** Review (#218): approve a held card. */
operatorGiftCardRoutes.post('/:id/approve', UPDATE, async (c) => {
	const found = await cardFor(c)
	if ('error' in found) return found.error
	try {
		const result = await approveHeldGiftCard({
			orgId: found.auth.orgId,
			cardId: found.card.id,
			actor: actorOf(c),
		})
		return giftCardDeny(200, 'ok', result)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

const refundPurchaseSchema = z.strictObject({
	/** Omit to refund everything unspent. */
	amountMinor: z.number().int().min(1).max(10_000_000).optional(),
})

/**
 * Review (#218): books the removal of the unspent balance of an online
 * purchase and answers what the App may refund to the payer (never more than
 * the unspent balance). The App then calls the payment provider.
 */
operatorGiftCardRoutes.post('/:id/refund-purchase', UPDATE, async (c) => {
	const body = await readJsonBody(c, refundPurchaseSchema)
	if ('error' in body) return body.error
	const found = await cardFor(c)
	if ('error' in found) return found.error
	try {
		const result = await bookGiftCardPurchaseRefund({
			orgId: found.auth.orgId,
			cardId: found.card.id,
			amountMinor: body.data.amountMinor,
			actor: actorOf(c),
		})
		return giftCardDeny(200, 'ok', result)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})


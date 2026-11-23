import { Hono, type Context } from 'hono'
import {
	GiftCardDomainError,
	type GiftCardFeatures,
} from '@repo/common/gift-cards'
import {
	posGiftCardLookupSchema,
	posGiftCardRedeemSchema,
	posGiftCardRefundSchema,
	posGiftCardSellSchema,
	posGiftCardTopUpSchema,
} from '@repo/common/gift-card-contract'
import { giftCardLedger, type TenantDatabase } from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import {
	getGiftCardFlagState,
	type GiftCardFlagState,
} from '../lib/gift-card-context.ts'
import {
	giftCardDeny,
	giftCardErrorResponse,
	giftCardIdempotency,
	giftCardKillSwitchResponse,
} from '../lib/gift-card-http.ts'
import {
	chargeGiftCardGuess,
	settleGiftCardGuess,
} from '../lib/gift-card-rate-limit.ts'
import { withGiftCardWrite } from '../lib/gift-card-write.ts'
import { readJsonBody } from '../lib/http.ts'
import { authenticatePosDevice } from '../lib/pos-auth.ts'
import { verifyPosStaffSession } from '../lib/pos-staff-session.ts'
import { peekShowToken } from '../services/gift-card-account-service.ts'
import {
	SHOW_TOKEN_PREFIX,
	redeemGiftCardAtTill,
	refundGiftCardInTx,
	sellGiftCard,
	topUpGiftCard,
} from '../services/gift-card-service.ts'
import {
	findGiftCardByCode,
	giftCardBalance,
	guestViewOf,
	type GiftCardActor,
} from '../services/gift-card-store.ts'

/**
 * Till gift-card routes (`/pos/gift-cards/*`), called browser-direct by a
 * paired Station terminal, online only: nothing here is queued offline, and
 * the till says so instead of trying. The device secret authenticates the
 * terminal; when it requires sign-in a staff session is needed too, and the
 * staff member is the named actor on every entry. Selling, topping up and
 * redeeming need the node's kill switch off and `gift_cards.pos` on; a lookup
 * only needs the organization's gift cards on.
 */
export const posGiftCardRoutes = new Hono()

type TillPos = {
	orgId: string
	device: { id: string; locationId: string | null }
	db: TenantDatabase
	actor: GiftCardActor
}

async function requireTill(
	c: Context,
): Promise<{ pos: TillPos } | { error: Response }> {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth
	let actor: GiftCardActor = { id: `device:${auth.pos.device.id}`, name: null }
	if (auth.pos.device.signInRequired) {
		const staff = await verifyPosStaffSession(c, auth.pos)
		if ('error' in staff) return staff
		actor = {
			id: staff.session.staffId,
			name: staff.session.staff.name,
		}
	}
	return {
		pos: {
			orgId: auth.pos.orgId,
			device: {
				id: auth.pos.device.id,
				locationId: auth.pos.device.locationId ?? null,
			},
			db: auth.pos.db,
			actor,
		},
	}
}

async function requireWork(
	c: Context,
	options: { new: boolean },
): Promise<
	| { pos: TillPos; state: GiftCardFlagState; features: GiftCardFeatures }
	| { error: Response }
> {
	const till = await requireTill(c)
	if ('error' in till) return till
	if (options.new) {
		const killed = giftCardKillSwitchResponse()
		if (killed) return { error: killed }
	}
	const state = await getGiftCardFlagState(till.pos.orgId)
	if (state.status === 'unknown' || state.status === 'stopped') {
		if (options.new || state.status === 'unknown') {
			return { error: giftCardDeny(503, 'gift_cards_unavailable') }
		}
	}
	const enabled = state.status === 'stopped' ? true : state.features.enabled
	if (!enabled) return { error: giftCardDeny(403, 'gift_cards_disabled') }
	if (options.new && !state.features.pos) {
		return { error: giftCardDeny(403, 'feature_disabled', { feature: 'pos' }) }
	}
	return { pos: till.pos, state, features: state.features }
}

/** Looks a card up by a typed or scanned code, or a guest's show token. Spends nothing. */
posGiftCardRoutes.post('/lookup', async (c) => {
	try {
		const gate = await requireWork(c, { new: false })
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, posGiftCardLookupSchema)
		if ('error' in body) return body.error
		const now = Date.now()
		if (body.data.code.startsWith(SHOW_TOKEN_PREFIX)) {
			const card = await peekShowToken(gate.pos.db, body.data.code, now)
			if (!card) throw new GiftCardDomainError('code_invalid')
			return giftCardDeny(
				200,
				'ok',
				guestViewOf(card, await giftCardBalance(gate.pos.db, card.id), now),
			)
		}
		const charge = await chargeGiftCardGuess(gate.pos.db, {
			orgId: gate.pos.orgId,
			subject: { kind: 'device', deviceId: gate.pos.device.id },
		})
		const card = await findGiftCardByCode(gate.pos.db, body.data.code)
		const known = card && card.status !== 'pending'
		await settleGiftCardGuess(gate.pos.db, charge, known ? 'right' : 'wrong')
		if (!card || !known) throw new GiftCardDomainError('code_invalid')
		return giftCardDeny(
			200,
			'ok',
			guestViewOf(card, await giftCardBalance(gate.pos.db, card.id), now),
		)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

/** Sells a card (cash or terminal) or activates a printed one with the paid amount. */
posGiftCardRoutes.post('/sell', async (c) => {
	try {
		const gate = await requireWork(c, { new: true })
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, posGiftCardSellSchema)
		if ('error' in body) return body.error
		const idem = giftCardIdempotency(
			c,
			`pos-sell:${gate.pos.device.id}`,
			body.data,
		)
		if ('error' in idem) return idem.error
		const currency = gate.state.currency
		if (!currency) return giftCardDeny(503, 'gift_cards_unavailable')
		const sold = await sellGiftCard({
			orgId: gate.pos.orgId,
			code: body.data.code,
			amountMinor: body.data.amountMinor,
			currency,
			locationId: gate.pos.device.locationId,
			actor: gate.pos.actor,
			deviceId: gate.pos.device.id,
			clientRequestId: body.data.clientRequestId,
			paymentMethod: body.data.paymentMethod,
			settings: gate.state.settings,
			idempotency: idem.idempotency,
		})
		return giftCardDeny(200, 'ok', sold)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

posGiftCardRoutes.post('/top-up', async (c) => {
	try {
		const gate = await requireWork(c, { new: true })
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, posGiftCardTopUpSchema)
		if ('error' in body) return body.error
		const idem = giftCardIdempotency(
			c,
			`pos-top-up:${gate.pos.device.id}`,
			body.data,
		)
		if ('error' in idem) return idem.error
		const result = await topUpGiftCard({
			orgId: gate.pos.orgId,
			code: body.data.code,
			amountMinor: body.data.amountMinor,
			locationId: gate.pos.device.locationId,
			actor: gate.pos.actor,
			deviceId: gate.pos.device.id,
			clientRequestId: body.data.clientRequestId,
			settings: gate.state.settings,
			idempotency: idem.idempotency,
		})
		return giftCardDeny(200, 'ok', result)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

/** Takes at most the balance off a card for a sale; the till then records the tender. */
posGiftCardRoutes.post('/redeem', async (c) => {
	try {
		const gate = await requireWork(c, { new: true })
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, posGiftCardRedeemSchema)
		if ('error' in body) return body.error
		const idem = giftCardIdempotency(
			c,
			`pos-redeem:${gate.pos.device.id}`,
			body.data,
		)
		if ('error' in idem) return idem.error
		const result = await redeemGiftCardAtTill({
			orgId: gate.pos.orgId,
			code: body.data.code,
			amountMinor: body.data.amountMinor,
			saleId: body.data.saleId,
			clientRequestId: body.data.clientRequestId,
			deviceId: gate.pos.device.id,
			locationId: gate.pos.device.locationId,
			actor: gate.pos.actor,
			idempotency: idem.idempotency,
		})
		return giftCardDeny(200, 'ok', result)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

/**
 * Returns money to the card when a till sale paid with it is refunded. Never
 * more than that redemption took, and never stopped by the kill switch or a
 * void: money owed back is not stranded.
 */
posGiftCardRoutes.post('/refund', async (c) => {
	try {
		const gate = await requireWork(c, { new: false })
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, posGiftCardRefundSchema)
		if ('error' in body) return body.error
		const idem = giftCardIdempotency(
			c,
			`pos-refund:${gate.pos.device.id}`,
			body.data,
		)
		if ('error' in idem) return idem.error
		const result = await withGiftCardWrite(
			{ orgId: gate.pos.orgId, idempotency: idem.idempotency },
			async (tx, ctx) => {
				// Only a redemption made at this terminal can be refunded from it.
				const redeem = await tx
					.select({ id: giftCardLedger.id, cardId: giftCardLedger.cardId })
					.from(giftCardLedger)
					.where(
						and(
							eq(giftCardLedger.id, body.data.reference),
							eq(giftCardLedger.kind, 'redeem'),
							eq(giftCardLedger.sourceType, 'pos_order'),
						),
					)
					.get()
				if (!redeem) throw new GiftCardDomainError('not_found')
				ctx.linkCard(redeem.cardId)
				const { entry } = await refundGiftCardInTx(tx, {
					redeemEntryId: redeem.id,
					amountMinor: body.data.amountMinor,
					idempotencyKey: `refund:pos:${gate.pos.device.id}:${body.data.clientRequestId}`,
					actor: gate.pos.actor,
					reason: 'till refund',
					now: ctx.now,
				})
				return {
					cardId: redeem.cardId,
					refundId: entry.id,
					balanceMinor: await giftCardBalance(tx, redeem.cardId),
				}
			},
		)
		return giftCardDeny(200, 'ok', result)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

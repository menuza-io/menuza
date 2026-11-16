import { Hono, type Context } from 'hono'
import {
	GIFT_CARD_MAX_DELIVER_AHEAD_MS,
	GiftCardDomainError,
	enabledGiftCardDesigns,
	type GiftCardSettings,
} from '@repo/common/gift-cards'
import {
	giftCardBalanceRequestSchema,
	giftCardBindingSchema,
	giftCardClaimRequestSchema,
	giftCardPurchaseRequestSchema,
	giftCardShowTokenRequestSchema,
} from '@repo/common/gift-card-contract'
import { getTenantDb } from '@repo/tenant-db'
import { addressBucket, clientAddress } from '../lib/client-ip.ts'
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
	enforceGiftCardPurchaseLimit,
	settleGiftCardGuess,
	type GiftCardGuessSubject,
} from '../lib/gift-card-rate-limit.ts'
import { readJsonBody, readQuery } from '../lib/http.ts'
import {
	verificationFailedResponse,
	verifyPublicChallenge,
} from '../lib/reservations-public-auth.ts'
import { getBearerToken } from '../lib/secrets.ts'
import {
	claimGiftCard,
	createShowToken,
	listSavedGiftCards,
} from '../services/gift-card-account-service.ts'
import { createGiftCardPurchase } from '../services/gift-card-purchase-service.ts'
import {
	findGiftCardByCode,
	giftCardBalance,
	guestViewOf,
} from '../services/gift-card-store.ts'
import { authenticateCustomer } from './auth.ts'
import { resolveOrderingOrganization } from './orders.ts'

/**
 * Public gift-card routes (browser-direct, `/gift-cards/*`). The organization
 * comes from the browser Origin plus the site's slug or host, never from a
 * client-sent id. Wrong-code guesses are limited per address, customer and
 * organization like coupons; a Turnstile token guards the balance check and a
 * guest purchase. Responses are `private, no-store`; nothing logs a code.
 */
export const giftCardRoutes = new Hono()

/** Counted on the stream itself, so a chunked body cannot skip the cap. */
const MAX_BODY_BYTES = 20_000
const BODY_LIMIT = { maxBytes: MAX_BODY_BYTES }

function bucketOf(c: Context): string | null {
	const address = clientAddress(c)
	return address ? addressBucket(address) : null
}

async function publicOrg(
	c: Context,
	identity: { slug?: string; host?: string },
	need: 'enabled' | 'online',
): Promise<
	| {
			orgId: string
			state: GiftCardFlagState
			organization: { id: string; dataRegion: string }
	  }
	| { error: Response }
> {
	const resolved = await resolveOrderingOrganization(c, identity)
	if ('error' in resolved) return { error: resolved.error }
	const orgId = resolved.organization.id
	const state = await getGiftCardFlagState(orgId)
	// Unreadable flags are a temporary 503; "off" is a uniform 404.
	if (state.status === 'unknown') {
		return { error: giftCardDeny(503, 'gift_cards_unavailable') }
	}
	if (state.status === 'stopped') {
		// The kill switch stops new sales; balance reads and wallets keep working.
		if (need === 'online')
			return { error: giftCardDeny(503, 'gift_cards_unavailable') }
		return {
			orgId,
			state: {
				...state,
				features: { enabled: true, online: false, pos: false },
			},
			organization: resolved.organization,
		}
	}
	if (
		!state.features.enabled ||
		(need === 'online' && !state.features.online)
	) {
		return { error: giftCardDeny(404, 'not_found') }
	}
	return { orgId, state, organization: resolved.organization }
}

/** The organization hints of a read, with the bounds a POST body's carry. */
function identityOf(
	c: Context,
): { data: { slug?: string; host?: string } } | { error: Response } {
	return readQuery(c, giftCardBindingSchema)
}

function optionsBody(state: GiftCardFlagState, settings: GiftCardSettings) {
	const designs = enabledGiftCardDesigns(settings)
	return {
		enabled: state.features.online,
		currency: state.currency,
		presetsMinor: settings.presetsMinor,
		minAmountMinor: settings.minAmountMinor,
		maxAmountMinor: Math.min(
			settings.maxAmountMinor,
			settings.limits.maxCardMajor * 100,
			settings.limits.maxPerPurchaseMajor * 100,
		),
		allowCustomAmount: settings.allowCustomAmount,
		designs: designs.map((design) => ({
			key: design.key,
			imageUrl: design.key === 'custom' ? (design.imageKey ?? null) : null,
		})),
		defaultDesign: settings.defaultDesign,
		locations: state.locations.map((location) => ({
			id: location.id,
			name: location.name ?? null,
			timeZone: location.timeZone ?? null,
		})),
		maxDeliverAheadDays: Math.floor(
			GIFT_CARD_MAX_DELIVER_AHEAD_MS / 86_400_000,
		),
	}
}

/** What the purchase page shows: presets, bounds, designs, locations. */
giftCardRoutes.get('/options', async (c) => {
	const identity = identityOf(c)
	if ('error' in identity) return identity.error
	const org = await publicOrg(c, identity.data, 'enabled')
	if ('error' in org) return org.error
	return giftCardDeny(200, 'ok', optionsBody(org.state, org.state.settings))
})

async function optionalCustomer(
	c: Context,
	orgId: string,
): Promise<{ customerId: string | null } | { error: Response }> {
	if (!getBearerToken(c.req.header('Authorization')))
		return { customerId: null }
	try {
		const auth = await authenticateCustomer(c)
		if (auth.organization.id !== orgId) {
			return { error: giftCardDeny(403, 'forbidden') }
		}
		return { customerId: auth.customerId }
	} catch (response) {
		return { error: response as Response }
	}
}

async function requiredCustomer(
	c: Context,
	orgId: string,
): Promise<{ customerId: string } | { error: Response }> {
	const result = await optionalCustomer(c, orgId)
	if ('error' in result) return result
	if (!result.customerId) return { error: giftCardDeny(401, 'unauthorized') }
	return { customerId: result.customerId }
}

/** `POST /gift-cards/purchase`: starts an online purchase; the browser pays through the hosted checkout. */
giftCardRoutes.post('/purchase', async (c) => {
	const body = await readJsonBody(c, giftCardPurchaseRequestSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	const request = body.data
	const org = await publicOrg(
		c,
		{ slug: request.slug, host: request.host },
		'online',
	)
	if ('error' in org) return org.error
	const customer = await optionalCustomer(c, org.orgId)
	if ('error' in customer) return customer.error
	if (
		!(await verifyPublicChallenge(c, request.turnstileToken, {
			hasCustomer: customer.customerId !== null,
		}))
	) {
		return verificationFailedResponse()
	}
	try {
		const killed = giftCardKillSwitchResponse()
		if (killed) return killed
		const db = await getTenantDb(org.orgId)
		await enforceGiftCardPurchaseLimit(db, org.orgId, {
			address: bucketOf(c),
			customerId: customer.customerId,
		})
		const {
			slug: ignoredSlug,
			host: ignoredHost,
			turnstileToken: ignoredToken,
			...rest
		} = request
		const idem = giftCardIdempotency(c, `purchase:${org.orgId}`, rest)
		if ('error' in idem) return idem.error
		const currency = org.state.currency
		if (!currency) return giftCardDeny(503, 'gift_cards_unavailable')
		const settings = org.state.settings
		if (
			request.locationId &&
			!org.state.locations.some(
				(location) => location.id === request.locationId,
			)
		) {
			throw new GiftCardDomainError('invalid_request')
		}
		const started = await createGiftCardPurchase({
			orgId: org.orgId,
			idempotency: idem.idempotency,
			settings,
			currency,
			locationId: request.locationId ?? null,
			amountMinor: request.amountMinor,
			designKey: request.designKey ?? settings.defaultDesign,
			recipient: request.recipient
				? {
						name: request.recipient.name ?? null,
						email: request.recipient.email,
					}
				: null,
			sendToSelf: request.sendToSelf,
			senderName: request.senderName ?? null,
			message: request.message ?? null,
			deliverAt: request.deliverAt ?? null,
			purchaser: {
				customerId: customer.customerId,
				name: request.purchaser.name ?? null,
				email: request.purchaser.email,
			},
			locale: request.locale ?? null,
			deviceId: request.deviceId ?? null,
		})
		return giftCardDeny(201, 'ok', started)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

/** `POST /gift-cards/balance`: the balance of a card by its code (Turnstile protected). */
giftCardRoutes.post('/balance', async (c) => {
	const body = await readJsonBody(c, giftCardBalanceRequestSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	const org = await publicOrg(
		c,
		{ slug: body.data.slug, host: body.data.host },
		'enabled',
	)
	if ('error' in org) return org.error
	if (
		!(await verifyPublicChallenge(c, body.data.turnstileToken, {
			hasCustomer: false,
		}))
	) {
		return verificationFailedResponse()
	}
	try {
		const db = await getTenantDb(org.orgId)
		const subject: GiftCardGuessSubject = {
			kind: 'guest',
			address: bucketOf(c),
		}
		const charge = await chargeGiftCardGuess(db, { orgId: org.orgId, subject })
		const card = await findGiftCardByCode(db, body.data.code)
		const known = card && card.status !== 'pending'
		await settleGiftCardGuess(db, charge, known ? 'right' : 'wrong')
		if (!card || !known) throw new GiftCardDomainError('code_invalid')
		const view = guestViewOf(
			card,
			await giftCardBalance(db, card.id),
			Date.now(),
		)
		return giftCardDeny(200, 'ok', view)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

/** `GET /gift-cards/mine`: the signed-in guest's saved cards. */
giftCardRoutes.get('/mine', async (c) => {
	const identity = identityOf(c)
	if ('error' in identity) return identity.error
	const org = await publicOrg(c, identity.data, 'enabled')
	if ('error' in org) return org.error
	const customer = await requiredCustomer(c, org.orgId)
	if ('error' in customer) return customer.error
	try {
		const cards = await listSavedGiftCards(org.orgId, customer.customerId)
		return giftCardDeny(200, 'ok', { cards })
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

/** `POST /gift-cards/claim`: saves a card to the guest's account by its full code. */
giftCardRoutes.post('/claim', async (c) => {
	const body = await readJsonBody(c, giftCardClaimRequestSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	const org = await publicOrg(
		c,
		{ slug: body.data.slug, host: body.data.host },
		'online',
	)
	if ('error' in org) return org.error
	const customer = await requiredCustomer(c, org.orgId)
	if ('error' in customer) return customer.error
	try {
		const db = await getTenantDb(org.orgId)
		const charge = await chargeGiftCardGuess(db, {
			orgId: org.orgId,
			subject: {
				kind: 'customer',
				customerId: customer.customerId,
				address: bucketOf(c),
			},
		})
		// A guess is given back only once the service has positively found the
		// card. Any other failure (a refusal, a busy database) counts as wrong, so
		// a new error path can never hand attempts back for free.
		let resolved = false
		let result
		try {
			result = await claimGiftCard({
				orgId: org.orgId,
				customerId: customer.customerId,
				code: body.data.code,
				onResolved: () => {
					resolved = true
				},
			})
		} catch (error) {
			await settleGiftCardGuess(db, charge, resolved ? 'right' : 'wrong')
			throw error
		}
		await settleGiftCardGuess(db, charge, 'right')
		return giftCardDeny(200, 'ok', {
			card: result.card,
			alreadyMine: result.alreadyMine,
		})
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

/** `POST /gift-cards/:id/show-token`: a short-lived QR token for the till (not the code). */
giftCardRoutes.post('/:id/show-token', async (c) => {
	const body = await readJsonBody(c, giftCardShowTokenRequestSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	const org = await publicOrg(
		c,
		{ slug: body.data.slug, host: body.data.host },
		'online',
	)
	if ('error' in org) return org.error
	const customer = await requiredCustomer(c, org.orgId)
	if ('error' in customer) return customer.error
	try {
		const token = await createShowToken({
			orgId: org.orgId,
			customerId: customer.customerId,
			cardId: c.req.param('id'),
		})
		return giftCardDeny(200, 'ok', token)
	} catch (error) {
		return giftCardErrorResponse(error)
	}
})

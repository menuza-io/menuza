import { Hono, type Context } from 'hono'
import { z } from 'zod'

import {
	activeCateringCutoffs,
	cateringQuoteRequestSchema,
	CATERING_BALANCE_TOKEN_HEADER,
	CATERING_QUOTE_TOKEN_HEADER,
	type CateringSettings,
} from '@repo/common/catering'
import { pickLocalized } from '@repo/common/site-locales'

import { isCateringPublicDisabled } from '../lib/catering-switches.ts'
import { readJsonBody, readQuery, NO_STORE } from '../lib/http.ts'
import {
	verificationFailedResponse,
	verifyPublicChallenge,
} from '../lib/reservations-public-auth.ts'
import { getBearerToken } from '../lib/secrets.ts'
import {
	getGuestBalance,
	startBalancePayment,
} from '../services/catering-balance.ts'
import {
	acceptQuoteForPayment,
	createGuestQuoteRequest,
	getGuestQuote,
	loadCateringEnv,
} from '../services/catering-quotes.ts'
import {
	type OrderServiceFailure,
	type OrderServiceResult,
} from '../services/order-service.ts'
import { authenticateCustomer } from './auth.ts'
import { resolveOrderingOrganization } from './orders.ts'

/**
 * Guest catering routes (browser-direct, `/catering/*`, #124, #361). The
 * organization comes from the browser Origin plus the site's slug or host,
 * never from a client-sent id, and every refusal that would tell a caller what
 * exists is the same answer. `CATERING_PUBLIC_ENABLED=false` answers 503
 * `catering_unavailable` on every route here. The quote and balance links are
 * capabilities (`X-Quote-Token`, `X-Balance-Token`): an HMAC of the id and its
 * version that the guest keeps in the URL fragment, so a forged, reused or
 * old-version token is the same refusal. Nothing here logs a name, phone,
 * address, note or token.
 */
export const cateringRoutes = new Hono()

const BODY_LIMIT = { maxBytes: 40_000 }
const UUID = /^[A-Za-z0-9_-]{8,64}$/

const bindingSchema = z.strictObject({
	slug: z.string().trim().min(1).max(100).optional(),
	host: z.string().trim().min(1).max(253).optional(),
})

const optionsQuerySchema = bindingSchema.extend({
	locationId: z.string().min(1).max(100),
	locale: z.string().trim().min(2).max(10).optional(),
})

const payBodySchema = bindingSchema

function deny(
	status: number,
	code: string,
	extra: Record<string, unknown> = {},
) {
	return Response.json(
		{ error: code, code, ...extra },
		{ status, headers: NO_STORE },
	)
}

function unavailable() {
	return deny(503, 'catering_unavailable')
}

function failure(f: OrderServiceFailure): Response {
	return Response.json(
		{
			error: f.code,
			code: f.code,
			message: f.message,
			...(f.details ? { details: f.details } : {}),
		},
		{ status: f.status, headers: NO_STORE },
	)
}

function respond<T>(result: OrderServiceResult<T>, status: 200 | 201 = 200) {
	return result.ok
		? Response.json(result.data, { status, headers: NO_STORE })
		: failure(result.failure)
}

async function publicOrg(
	c: Context,
	identity: { slug?: string; host?: string },
): Promise<{ orgId: string } | { error: Response }> {
	if (isCateringPublicDisabled()) return { error: unavailable() }
	const resolved = await resolveOrderingOrganization(c, identity)
	if ('error' in resolved) return { error: deny(404, 'not_found') }
	return { orgId: resolved.organization.id }
}

function tokenHeader(c: Context, name: string): string {
	return (c.req.header(name) ?? '').trim()
}

function publicSettings(settings: CateringSettings) {
	// Everything a guest page may show; never the alert members.
	const { alertUserIds: ignoredAlerts, ...rest } = settings
	void ignoredAlerts
	return rest
}

/**
 * `GET /catering/options?locationId=`: what the catering page shows: the
 * notice, the window, the limits, the order-by cutoffs resolved in the
 * location's zone, the deposit and the typed answers. Business settings only.
 */
cateringRoutes.get('/options', async (c) => {
	const query = readQuery(c, optionsQuerySchema)
	if ('error' in query) return query.error
	const org = await publicOrg(c, query.data)
	if ('error' in org) return org.error
	const env = await loadCateringEnv(org.orgId, query.data.locationId)
	if (!env.ok || !env.data.policy) return deny(404, 'not_found')
	const { policy, location, context } = env.data
	const timeZone = location.timezone || 'UTC'
	const locale =
		query.data.locale ?? context.menu.organization.defaultLocale ?? 'en'
	const defaultLocale = context.menu.organization.defaultLocale ?? 'en'
	const now = Date.now()
	return Response.json(
		{
			enabled: true,
			quotes: policy.quotes,
			quoteMode: policy.settings.quoteMode,
			currency: location.currency || context.menu.organization.currency,
			timeZone,
			serverNow: now,
			settings: publicSettings(policy.settings),
			cutoffs: activeCateringCutoffs(policy.settings, now, timeZone).map(
				(cutoff) => ({
					id: cutoff.id,
					from: cutoff.from,
					to: cutoff.to,
					orderByAtMs: cutoff.orderByAtMs,
					closed: cutoff.closed,
					note: cutoff.note
						? pickLocalized(cutoff.note, locale, defaultLocale)
						: null,
				}),
			),
			facts: {
				currency: location.currency || context.menu.organization.currency,
				deliveryZoneNames: (location.deliveryZones ?? [])
					.filter((zone) => zone.enabled !== false)
					.map((zone) => String(zone.name ?? ''))
					.filter(Boolean),
				deliveryFeeMinor: lowestZoneFeeMinor(location.deliveryZones),
			},
		},
		{ headers: NO_STORE },
	)
})

function lowestZoneFeeMinor(
	zones:
		| ReadonlyArray<{ enabled?: boolean; deliveryFee?: number | null }>
		| undefined,
): number | null {
	const fees = (zones ?? [])
		.filter((zone) => zone.enabled !== false)
		.map((zone) => zone.deliveryFee)
		.filter((fee): fee is number => typeof fee === 'number' && fee > 0)
	return fees.length > 0 ? Math.round(Math.min(...fees) * 100) : null
}

async function optionalCustomer(
	c: Context,
	orgId: string,
): Promise<{ customerId: string | null } | { error: Response }> {
	if (!getBearerToken(c.req.header('Authorization')))
		return { customerId: null }
	try {
		const auth = await authenticateCustomer(c)
		if (auth.organization.id !== orgId) return { error: deny(403, 'forbidden') }
		return { customerId: auth.customerId }
	} catch (response) {
		return { error: response as Response }
	}
}

/** `POST /catering/quote-requests`: a guest asks for a quote. Answers the request id only. */
cateringRoutes.post('/quote-requests', async (c) => {
	const body = await readJsonBody(c, cateringQuoteRequestSchema, BODY_LIMIT)
	if ('error' in body) return body.error
	const request = body.data
	const org = await publicOrg(c, { slug: request.slug, host: request.host })
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
	const result = await createGuestQuoteRequest({
		orgId: org.orgId,
		request,
		customerId: customer.customerId,
	})
	if (!result.ok) return failure(result.failure)
	return Response.json(
		{ requestId: result.data.quoteId, replayed: result.data.replayed },
		{ status: result.data.replayed ? 200 : 201, headers: NO_STORE },
	)
})

/** `GET /catering/quotes/:id` with `X-Quote-Token`: the quote the guest was sent. */
cateringRoutes.get('/quotes/:id', async (c) => {
	const id = c.req.param('id')
	const query = readQuery(c, bindingSchema)
	if ('error' in query) return query.error
	const org = await publicOrg(c, query.data)
	if ('error' in org) return org.error
	if (!UUID.test(id)) return deny(403, 'invalid_quote_token')
	return respond(
		await getGuestQuote({
			orgId: org.orgId,
			quoteId: id,
			token: tokenHeader(c, CATERING_QUOTE_TOKEN_HEADER),
		}),
	)
})

/**
 * `POST /catering/quotes/:id/pay` with `X-Quote-Token`: accepts the quote and
 * starts paying. Answers the `quote:<id>` ref and the payment token the hosted
 * checkout (`POST /resources/sites/order/checkout`) takes.
 */
cateringRoutes.post('/quotes/:id/pay', async (c) => {
	const id = c.req.param('id')
	const body = await readJsonBody(c, payBodySchema, BODY_LIMIT)
	if ('error' in body) return body.error
	const org = await publicOrg(c, body.data)
	if ('error' in org) return org.error
	if (!UUID.test(id)) return deny(403, 'invalid_quote_token')
	return respond(
		await acceptQuoteForPayment({
			orgId: org.orgId,
			quoteId: id,
			token: tokenHeader(c, CATERING_QUOTE_TOKEN_HEADER),
		}),
	)
})

/** `GET /catering/balance/:orderId` with `X-Balance-Token`. */
cateringRoutes.get('/balance/:orderId', async (c) => {
	const orderId = c.req.param('orderId')
	const query = readQuery(c, bindingSchema)
	if ('error' in query) return query.error
	const org = await publicOrg(c, query.data)
	if ('error' in org) return org.error
	if (!UUID.test(orderId)) return deny(403, 'invalid_balance_token')
	return respond(
		await getGuestBalance({
			orgId: org.orgId,
			orderId,
			token: tokenHeader(c, CATERING_BALANCE_TOKEN_HEADER),
		}),
	)
})

/** `POST /catering/balance/:orderId/pay` with `X-Balance-Token`: starts paying the balance. */
cateringRoutes.post('/balance/:orderId/pay', async (c) => {
	const orderId = c.req.param('orderId')
	const body = await readJsonBody(c, payBodySchema, BODY_LIMIT)
	if ('error' in body) return body.error
	const org = await publicOrg(c, body.data)
	if ('error' in org) return org.error
	if (!UUID.test(orderId)) return deny(403, 'invalid_balance_token')
	return respond(
		await startBalancePayment({
			orgId: org.orgId,
			orderId,
			token: tokenHeader(c, CATERING_BALANCE_TOKEN_HEADER),
		}),
	)
})

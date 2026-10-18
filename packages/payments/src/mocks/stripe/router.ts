import { type EmulatorContext } from '../context'
import { stripeId } from '../ids'
import {
	canonicalJson,
	jsonResponse,
	parseFormBody,
	sha256Hex,
	type Json,
} from '../util'
import {
	createAccount,
	createAccountLink,
	createLoginLink,
	retrieveAccount,
} from './accounts'
import {
	attachPaymentMethod,
	createCustomer,
	listCustomerPaymentMethods,
	retrieveCustomer,
	retrievePaymentMethod,
} from './customers'
import { STRIPE_API_VERSION, StripeApiError } from './errors'
import {
	cancelPaymentIntent,
	capturePaymentIntent,
	createPaymentIntent,
	retrievePaymentIntent,
	retrieveSetupIntent,
} from './intents'
import { createRefund, retrieveRefund } from './ledger'
import {
	createCheckoutSession,
	expireCheckoutSession,
	retrieveCheckoutSession,
} from './sessions'
import { publicObject, requireStripeObject } from './state'

type Handler = (
	ctx: EmulatorContext,
	match: RegExpMatchArray,
	params: Json,
) => Promise<unknown>

const ROUTES: Array<{
	method: 'GET' | 'POST'
	pattern: RegExp
	handler: Handler
}> = [
	{
		method: 'POST',
		pattern: /^\/v1\/accounts$/,
		handler: (c, _m, p) => createAccount(c, p),
	},
	{
		method: 'GET',
		pattern: /^\/v1\/accounts\/([^/]+)$/,
		handler: (c, m) => retrieveAccount(c, m[1]!),
	},
	{
		method: 'POST',
		pattern: /^\/v1\/accounts\/([^/]+)\/login_links$/,
		handler: (c, m) => createLoginLink(c, m[1]!),
	},
	{
		method: 'POST',
		pattern: /^\/v1\/account_links$/,
		handler: (c, _m, p) => createAccountLink(c, p),
	},

	{
		method: 'POST',
		pattern: /^\/v1\/customers$/,
		handler: (c, _m, p) => createCustomer(c, p),
	},
	{
		method: 'GET',
		pattern: /^\/v1\/customers\/([^/]+)$/,
		handler: (c, m) => retrieveCustomer(c, m[1]!),
	},
	{
		method: 'GET',
		pattern: /^\/v1\/customers\/([^/]+)\/payment_methods$/,
		handler: (c, m) => listCustomerPaymentMethods(c, m[1]!),
	},

	{
		method: 'POST',
		pattern: /^\/v1\/checkout\/sessions$/,
		handler: (c, _m, p) => createCheckoutSession(c, p),
	},
	{
		method: 'GET',
		pattern: /^\/v1\/checkout\/sessions\/([^/]+)$/,
		handler: (c, m, p) => retrieveCheckoutSession(c, m[1]!, p),
	},
	{
		method: 'POST',
		pattern: /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/,
		handler: (c, m) => expireCheckoutSession(c, m[1]!),
	},

	{
		method: 'GET',
		pattern: /^\/v1\/setup_intents\/([^/]+)$/,
		handler: (c, m) => retrieveSetupIntent(c, m[1]!),
	},
	{
		method: 'GET',
		pattern: /^\/v1\/payment_methods\/([^/]+)$/,
		handler: (c, m) => retrievePaymentMethod(c, m[1]!),
	},
	{
		method: 'POST',
		pattern: /^\/v1\/payment_methods\/([^/]+)\/attach$/,
		handler: (c, m, p) => attachPaymentMethod(c, m[1]!, p),
	},

	{
		method: 'POST',
		pattern: /^\/v1\/payment_intents$/,
		handler: (c, _m, p) => createPaymentIntent(c, p),
	},
	{
		method: 'GET',
		pattern: /^\/v1\/payment_intents\/([^/]+)$/,
		handler: (c, m, p) => retrievePaymentIntent(c, m[1]!, p),
	},
	{
		method: 'POST',
		pattern: /^\/v1\/payment_intents\/([^/]+)\/cancel$/,
		handler: (c, m, p) => cancelPaymentIntent(c, m[1]!, p),
	},
	{
		method: 'POST',
		pattern: /^\/v1\/payment_intents\/([^/]+)\/capture$/,
		handler: (c, m, p) => capturePaymentIntent(c, m[1]!, p),
	},

	{
		method: 'POST',
		pattern: /^\/v1\/refunds$/,
		handler: (c, _m, p) => createRefund(c, p),
	},
	{
		method: 'GET',
		pattern: /^\/v1\/refunds\/([^/]+)$/,
		handler: (c, m) => retrieveRefund(c, m[1]!),
	},
	{
		method: 'GET',
		pattern: /^\/v1\/charges\/([^/]+)$/,
		handler: async (c, m) =>
			publicObject(
				(await requireStripeObject(c, m[1]!, 'charge', 'charge')).json,
			),
	},
]

const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000

function requestHeaders(extra: Record<string, string> = {}) {
	return {
		'request-id': stripeId('req_mock_', 14),
		'stripe-version': STRIPE_API_VERSION,
		...extra,
	}
}

function errorResponse(
	error: StripeApiError,
	extra: Record<string, string> = {},
) {
	return jsonResponse(error.status, error.toEnvelope(), requestHeaders(extra))
}

/** Every Stripe request the SDK makes lands here. */
export async function handleStripeRequest(
	ctx: EmulatorContext,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url)
	const method = request.method.toUpperCase()
	const authorization = request.headers.get('authorization') ?? ''
	if (!/^Bearer sk_(test|live)_\S+$/.test(authorization)) {
		return errorResponse(
			new StripeApiError(
				401,
				'invalid_request_error',
				'You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth (e.g. "Authorization: Bearer YOUR_SECRET_KEY").',
			),
		)
	}
	const version = request.headers.get('stripe-version')
	if (version && !/^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/.test(version)) {
		return errorResponse(
			new StripeApiError(
				400,
				'invalid_request_error',
				`Invalid Stripe API version: ${version}`,
			),
		)
	}
	for (const route of ROUTES) {
		const match = url.pathname.match(route.pattern)
		if (!match) continue
		if (route.method !== method) {
			return errorResponse(
				new StripeApiError(
					405,
					'invalid_request_error',
					`Unrecognized request URL (${method}: ${url.pathname}).`,
				),
			)
		}
		const params = parseFormBody(
			method === 'GET' ? url.search.replace(/^\?/, '') : await request.text(),
		)
		return runRoute(ctx, route.handler, match, params, {
			method,
			path: url.pathname,
			idempotencyKey:
				method === 'POST' ? request.headers.get('idempotency-key') : null,
		})
	}
	ctx.log(
		`501 Stripe emulator does not implement ${method} ${url.pathname}. Add it to packages/payments/src/mocks/stripe/router.ts or avoid the call.`,
	)
	return jsonResponse(
		501,
		{
			error: {
				type: 'api_error',
				message: `Payments mock: ${method} ${url.pathname} is not implemented by the local Stripe emulator.`,
			},
		},
		requestHeaders(),
	)
}

async function runRoute(
	ctx: EmulatorContext,
	handler: Handler,
	match: RegExpMatchArray,
	params: Json,
	meta: { method: string; path: string; idempotencyKey: string | null },
) {
	let requestHash = ''
	if (meta.idempotencyKey) {
		requestHash = await sha256Hex(
			`${meta.method} ${meta.path} ${canonicalJson(params)}`,
		)
		const stored = await ctx.store.getIdempotency('stripe', meta.idempotencyKey)
		if (
			stored &&
			ctx.clock.now() - stored.createdAt < IDEMPOTENCY_RETENTION_MS
		) {
			if (stored.requestHash !== requestHash) {
				return errorResponse(
					new StripeApiError(
						400,
						'idempotency_error',
						`Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${meta.idempotencyKey}' if you meant to execute a different request.`,
					),
				)
			}
			return new Response(stored.response, {
				status: stored.status,
				headers: requestHeaders({
					'content-type': 'application/json',
					'idempotent-replayed': 'true',
				}),
			})
		}
	}
	let response: Response
	try {
		const result = await handler(ctx, match, params)
		response = jsonResponse(200, result, requestHeaders())
	} catch (error) {
		if (error instanceof StripeApiError) {
			response = errorResponse(error)
		} else {
			ctx.log(
				`Stripe emulator error on ${meta.method} ${meta.path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			response = jsonResponse(
				500,
				{
					error: {
						type: 'api_error',
						message: 'Payments mock internal error.',
					},
				},
				requestHeaders(),
			)
		}
	}
	if (meta.idempotencyKey && response.status < 500) {
		await ctx.store.putIdempotency({
			provider: 'stripe',
			key: meta.idempotencyKey,
			requestHash,
			status: response.status,
			response: await response.clone().text(),
			createdAt: ctx.clock.now(),
		})
	}
	return response
}

import { type EmulatorContext } from '../context'
import { MOCK_CHECKOUT_SECRET_KEY } from '../env'
import { checkoutId } from '../ids'
import { canonicalJson, jsonResponse, sha256Hex, type Json } from '../util'
import { createEntity, retrieveEntity } from './entities'
import { CheckoutApiError } from './errors'
import {
	createHostedPayment,
	createPayment,
	createPaymentSession,
	createRefund,
	listPaymentActions,
	retrieveHostedPayment,
	retrievePayment,
	searchPayments,
	voidPayment,
} from './payments'

type Handler = (
	ctx: EmulatorContext,
	match: RegExpMatchArray,
	body: unknown,
) => Promise<{ status: number; body: unknown }>

const ok = (body: unknown, status = 200) => ({ status, body })

const ROUTES: Array<{
	method: 'GET' | 'POST' | 'PUT'
	pattern: RegExp
	handler: Handler
}> = [
	{
		method: 'POST',
		pattern: /^\/accounts\/entities$/,
		handler: async (c, _m, b) => ok(await createEntity(c, b), 201),
	},
	{
		method: 'GET',
		pattern: /^\/accounts\/entities\/([^/]+)$/,
		handler: async (c, m) => ok(await retrieveEntity(c, m[1]!)),
	},
	{
		method: 'POST',
		pattern: /^\/hosted-payments$/,
		handler: async (c, _m, b) => ok(await createHostedPayment(c, b), 201),
	},
	{
		method: 'GET',
		pattern: /^\/hosted-payments\/([^/]+)$/,
		handler: async (c, m) => ok(await retrieveHostedPayment(c, m[1]!)),
	},
	{
		method: 'POST',
		pattern: /^\/payment-sessions$/,
		handler: async (c, _m, b) => ok(await createPaymentSession(c, b), 201),
	},
	{
		method: 'POST',
		pattern: /^\/payments\/search$/,
		handler: async (c, _m, b) => ok(await searchPayments(c, b)),
	},
	{
		method: 'POST',
		pattern: /^\/payments$/,
		handler: async (c, _m, b) => ok(await createPayment(c, b), 201),
	},
	{
		method: 'GET',
		pattern: /^\/payments\/([^/]+)$/,
		handler: async (c, m) => ok(await retrievePayment(c, m[1]!)),
	},
	{
		method: 'GET',
		pattern: /^\/payments\/([^/]+)\/actions$/,
		handler: async (c, m) => ok(await listPaymentActions(c, m[1]!)),
	},
	{
		method: 'POST',
		pattern: /^\/payments\/([^/]+)\/refunds$/,
		handler: async (c, m, b) => ok(await createRefund(c, m[1]!, b), 202),
	},
	{
		method: 'POST',
		pattern: /^\/payments\/([^/]+)\/voids$/,
		handler: async (c, m, b) => ok(await voidPayment(c, m[1]!, b), 202),
	},
]

const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000

function normalizeKey(value: string | null) {
	return (value ?? '').replace(/^Bearer\s+/i, '').trim()
}

/** Every Checkout.com request the SDK makes to the dedicated mock host lands here. */
export async function handleCheckoutRequest(
	ctx: EmulatorContext,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url)
	const method = request.method.toUpperCase()
	if (
		normalizeKey(request.headers.get('authorization')) !==
		MOCK_CHECKOUT_SECRET_KEY
	) {
		return new CheckoutApiError(401, null).toResponse()
	}
	for (const route of ROUTES) {
		const match = url.pathname.match(route.pattern)
		if (!match || route.method !== method) continue
		let body: unknown = undefined
		if (method !== 'GET') {
			const text = await request.text()
			try {
				body = text ? JSON.parse(text) : {}
			} catch {
				return new CheckoutApiError(422, 'request_invalid', [
					'json_invalid',
				]).toResponse()
			}
		}
		const keyed =
			method === 'POST' &&
			(url.pathname === '/payments' ||
				/^\/payments\/[^/]+\/refunds$/.test(url.pathname))
		return run(ctx, route.handler, match, body, {
			method,
			path: url.pathname,
			idempotencyKey: keyed ? request.headers.get('cko-idempotency-key') : null,
		})
	}
	ctx.log(
		`501 Checkout.com emulator does not implement ${method} ${url.pathname}. Add it to packages/payments/src/mocks/checkout-com/router.ts or avoid the call.`,
	)
	return jsonResponse(501, {
		request_id: checkoutId('req_'),
		error_type: 'not_implemented',
		error_codes: ['payments_mock_not_implemented'],
	})
}

async function run(
	ctx: EmulatorContext,
	handler: Handler,
	match: RegExpMatchArray,
	body: unknown,
	meta: { method: string; path: string; idempotencyKey: string | null },
) {
	let requestHash = ''
	if (meta.idempotencyKey) {
		requestHash = await sha256Hex(
			`${meta.method} ${meta.path} ${canonicalJson(body as Json)}`,
		)
		const stored = await ctx.store.getIdempotency(
			'checkout',
			meta.idempotencyKey,
		)
		if (
			stored &&
			ctx.clock.now() - stored.createdAt < IDEMPOTENCY_RETENTION_MS
		) {
			if (stored.requestHash !== requestHash) {
				return jsonResponse(409, {
					request_id: checkoutId('req_'),
					error_type: 'idempotency_key_mismatch',
					error_codes: ['idempotency_key_reused_with_different_request'],
				})
			}
			return new Response(stored.response === '' ? null : stored.response, {
				status: stored.status,
				headers: {
					'content-type': 'application/json',
					'cko-idempotent-replayed': 'true',
				},
			})
		}
	}
	let response: Response
	try {
		const result = await handler(ctx, match, body)
		response = jsonResponse(result.status, result.body, {
			'cko-request-id': checkoutId('req_'),
			'cko-version': '1.0.0',
		})
	} catch (error) {
		if (error instanceof CheckoutApiError) {
			response = error.toResponse()
		} else {
			ctx.log(
				`Checkout.com emulator error on ${meta.method} ${meta.path}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			response = jsonResponse(500, { error_type: 'processing_error' })
		}
	}
	if (meta.idempotencyKey && response.status < 500) {
		await ctx.store.putIdempotency({
			provider: 'checkout',
			key: meta.idempotencyKey,
			requestHash,
			status: response.status,
			response: await response.clone().text(),
			createdAt: ctx.clock.now(),
		})
	}
	return response
}

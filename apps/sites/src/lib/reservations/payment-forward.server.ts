import { acceptCheckoutUrl } from '~/lib/ordering/order-client'
import {
	getAppServiceBinding,
	getReservationPaymentToken,
	getPublicAppUrl,
} from '~/lib/worker-env'

const PURPOSES = [
	'deposit',
	'prepay',
	'experience',
	'guarantee',
	'fee',
] as const
const OPAQUE = /^[A-Za-z0-9_:.-]{1,128}$/
const ALLOWED_KEYS = new Set([
	'reservationId',
	'feeId',
	'paymentToken',
	'purpose',
	'locale',
])

export type ReservationPaymentBody = {
	reservationId?: string
	feeId?: string
	paymentToken: string
	purpose: (typeof PURPOSES)[number]
	locale?: string
}

/**
 * The only thing the browser may send: opaque ids and the payment capability.
 * Anything else (names, phones, amounts, a checkout URL) is rejected, and the
 * organization comes from the request host, never from the body.
 */
export function parseReservationPaymentBody(
	raw: unknown,
): ReservationPaymentBody | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
	const value = raw as Record<string, unknown>
	if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) return null
	const text = (key: string, max: number) => {
		const item = value[key]
		if (item === undefined) return undefined
		return typeof item === 'string' && item.trim().length <= max
			? item.trim()
			: null
	}
	const reservationId = text('reservationId', 128)
	const feeId = text('feeId', 128)
	const paymentToken = text('paymentToken', 512)
	const locale = text('locale', 10)
	const purpose = value.purpose
	if (
		reservationId === null ||
		feeId === null ||
		paymentToken === null ||
		locale === null ||
		!paymentToken ||
		paymentToken.length < 8 ||
		typeof purpose !== 'string' ||
		!(PURPOSES as readonly string[]).includes(purpose)
	) {
		return null
	}
	for (const id of [reservationId, feeId]) {
		if (id !== undefined && !OPAQUE.test(id)) return null
	}
	const isFee = purpose === 'fee'
	if (isFee ? !feeId || reservationId : !reservationId || feeId) return null
	return {
		...(reservationId ? { reservationId } : {}),
		...(feeId ? { feeId } : {}),
		paymentToken,
		purpose: purpose as ReservationPaymentBody['purpose'],
		...(locale ? { locale } : {}),
	}
}

export type ReservationPaymentScope = {
	slug?: string | null
	host?: string | null
	fetchImpl?: typeof fetch
	token?: string | null
	appUrl?: string
	production?: boolean
}

const NO_STORE = { 'Cache-Control': 'no-store' }
const CODE = /^[a-z][a-z0-9_]{0,63}$/

function fail(status: number, error: string, retryable = false) {
	return Response.json({ error, retryable }, { status, headers: NO_STORE })
}

/** Forwards `{ reservationId | feeId, paymentToken, purpose }` to the App and returns safe fields only. */
export async function forwardReservationPayment(
	request: Request,
	endpoint: 'checkout' | 'status',
	scope: ReservationPaymentScope,
) {
	if (request.headers.get('Origin') !== new URL(request.url).origin) {
		return fail(403, 'invalid_origin')
	}
	const parsed = parseReservationPaymentBody(
		await request.json().catch(() => null),
	)
	if (!parsed) return fail(400, 'invalid_payment_reference')
	const slug = scope.slug?.trim() || null
	const host = scope.host?.trim() || null
	if (Boolean(slug) === Boolean(host))
		return fail(404, 'organization_not_found')

	const token =
		scope.token === undefined ? getReservationPaymentToken() : scope.token
	if (!token) return fail(503, 'payment_unavailable', true)

	const binding = getAppServiceBinding()
	const send =
		scope.fetchImpl ?? (binding ? binding.fetch.bind(binding) : fetch)
	const appUrl = (scope.appUrl ?? getPublicAppUrl()).replace(/\/$/, '')
	try {
		const response = await send(
			`${appUrl}/resources/sites/reservation/${endpoint}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`,
					Origin: new URL(request.url).origin,
				},
				body: JSON.stringify({
					...parsed,
					...(slug ? { slug } : { host }),
				}),
				signal: AbortSignal.timeout(15000),
			},
		)
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: unknown
				retryable?: unknown
			} | null
			const code =
				typeof body?.error === 'string' && CODE.test(body.error)
					? body.error
					: 'payment_unavailable'
			// The App's 4xx answers are definite; its auth failure is our misconfiguration.
			const status =
				response.status === 401 || response.status === 403
					? 502
					: response.status >= 400 && response.status < 500
						? response.status
						: 502
			return fail(status, code, body?.retryable === true || status === 502)
		}
		const value = (await response.json()) as Record<string, unknown>
		if (!value || typeof value !== 'object') throw new Error('invalid')
		if (endpoint === 'checkout') {
			const checkoutUrl = acceptCheckoutUrl(String(value.checkoutUrl), {
				production: scope.production,
			})
			return Response.json(
				{
					checkoutUrl,
					sessionId: value.sessionId,
					processor: value.processor,
					purpose: value.purpose,
					mode: value.mode,
				},
				{ headers: NO_STORE },
			)
		}
		return Response.json(
			{
				paymentStatus: value.paymentStatus,
				reservationStatus: value.reservationStatus,
				expiresAt: value.expiresAt,
				purpose: value.purpose,
				mode: value.mode,
			},
			{ headers: NO_STORE },
		)
	} catch {
		return fail(502, 'payment_unavailable', true)
	}
}

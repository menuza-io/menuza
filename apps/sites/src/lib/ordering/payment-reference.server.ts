import { orderPaymentRequestSchema } from '@repo/common/order-receipt'
import { getAppServiceBinding, getPublicAppUrl } from '~/lib/worker-env'

/** The only Sites payment proxy carries opaque references, never order/contact data. */
export async function forwardPaymentReference(
	request: Request,
	endpoint: 'checkout' | 'status',
	fetchImpl?: typeof fetch,
) {
	if (request.headers.get('Origin') !== new URL(request.url).origin) {
		return Response.json({ error: 'invalid_origin' }, { status: 403 })
	}
	const parsed = orderPaymentRequestSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_payment_reference' },
			{ status: 400 },
		)
	}
	const binding = getAppServiceBinding()
	const send = fetchImpl ?? (binding ? binding.fetch.bind(binding) : fetch)
	try {
		const response = await send(
			`${getPublicAppUrl().replace(/\/$/, '')}/resources/sites/order/${endpoint}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Origin: new URL(request.url).origin,
				},
				body: JSON.stringify(parsed.data),
				signal: AbortSignal.timeout(15000),
			},
		)
		if (!response.ok) {
			return Response.json(
				{ error: 'payment_unavailable' },
				{
					status:
						response.status >= 400 && response.status < 500
							? response.status
							: 502,
					headers: { 'Cache-Control': 'no-store' },
				},
			)
		}
		const raw: unknown = await response.json()
		if (!raw || typeof raw !== 'object')
			throw new Error('Invalid payment response')
		const value = raw as Record<string, unknown>
		const safe =
			endpoint === 'checkout'
				? {
						checkoutUrl: value.checkoutUrl,
						sessionId: value.sessionId,
						processor: value.processor,
					}
				: {
						status: value.paymentStatus,
						orderStatus: value.orderStatus,
						holdExpiresAt: value.holdExpiresAt,
					}
		return Response.json(safe, { headers: { 'Cache-Control': 'no-store' } })
	} catch {
		return Response.json({ error: 'payment_unavailable' }, { status: 502 })
	}
}

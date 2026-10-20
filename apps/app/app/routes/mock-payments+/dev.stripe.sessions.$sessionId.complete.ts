import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	gateDevApi,
	methodNotAllowed,
	noStore,
	readDevBody,
} from '#app/utils/payments-mock/dev-api.server.ts'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'

const schema = z.object({
	card: z.string().trim().max(32).default('4242424242424242'),
	email: z.string().trim().max(200).optional(),
	expiry: z.string().trim().max(10).optional(),
	cvc: z.string().trim().max(4).optional(),
	threeDS: z.enum(['complete', 'fail']).optional(),
})

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

const STATUS = {
	paid: 200,
	saved: 200,
	requires_3ds: 200,
	declined: 402,
	invalid: 422,
	inactive: 409,
} as const

/**
 * Dev only: `POST /mock-payments/dev/stripe/sessions/:sessionId/complete`
 * pays (or saves a card on) a Checkout Session without a browser. 3DS cards
 * take `threeDS: 'complete' | 'fail'` (default `complete`).
 */
export async function action({ request, params }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	const body = await readDevBody(request, schema)
	const emulator = getPaymentsEmulator()
	const id = params.sessionId ?? ''
	if (!(await emulator.object('stripe', id))) {
		return Response.json({ error: 'session_not_found' }, { status: 404 })
	}
	const result = await emulator.testing.completeCheckout(id, body)
	return Response.json(result, {
		status: STATUS[result.status],
		headers: noStore,
	})
}

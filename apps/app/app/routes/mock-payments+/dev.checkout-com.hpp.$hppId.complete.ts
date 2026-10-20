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
	password: z.string().max(64).optional(),
})

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

const STATUS = {
	approved: 200,
	declined: 200,
	requires_3ds: 200,
	invalid: 422,
	inactive: 409,
} as const

/**
 * Dev only: `POST /mock-payments/dev/checkout-com/hpp/:hppId/complete` pays a
 * hosted payment page without a browser. 3DS cards use `password` (default
 * `Checkout1!`).
 */
export async function action({ request, params }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	const body = await readDevBody(request, schema)
	const emulator = getPaymentsEmulator()
	const id = params.hppId ?? ''
	if (!(await emulator.object('checkout', id))) {
		return Response.json({ error: 'hpp_not_found' }, { status: 404 })
	}
	const result = await emulator.testing.completeHostedPayment(id, body)
	return Response.json(result, {
		status: STATUS[result.status],
		headers: noStore,
	})
}

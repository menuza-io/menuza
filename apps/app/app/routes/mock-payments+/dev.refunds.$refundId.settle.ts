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
	outcome: z.enum(['succeeded', 'failed', 'approved', 'declined']).optional(),
})

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

/**
 * Dev only: `POST /mock-payments/dev/refunds/:refundId/settle { outcome }`
 * settles a pending refund: a Stripe `re_` refund (`succeeded` | `failed`) or a
 * Checkout.com refund action `act_` (`approved` | `declined`). Without an
 * outcome the card or the default decides.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	const { outcome } = await readDevBody(request, schema)
	const emulator = getPaymentsEmulator()
	const id = params.refundId ?? ''
	if (id.startsWith('act_')) {
		if (outcome === 'succeeded' || outcome === 'failed') {
			return Response.json({ error: 'invalid_outcome' }, { status: 400 })
		}
		try {
			const action = await emulator.testing.settleCheckoutRefund(id, outcome)
			return Response.json(action, { headers: noStore })
		} catch {
			return Response.json({ error: 'refund_not_found' }, { status: 404 })
		}
	}
	if (outcome === 'approved' || outcome === 'declined') {
		return Response.json({ error: 'invalid_outcome' }, { status: 400 })
	}
	if (!(await emulator.object('stripe', id))) {
		return Response.json({ error: 'refund_not_found' }, { status: 404 })
	}
	const refund = await emulator.testing.settleRefund(id, outcome)
	return Response.json(refund, { headers: noStore })
}

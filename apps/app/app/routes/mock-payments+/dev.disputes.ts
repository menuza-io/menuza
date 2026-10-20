import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	gateDevApi,
	methodNotAllowed,
	noStore,
	readDevBody,
} from '#app/utils/payments-mock/dev-api.server.ts'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'

const schema = z.object({ paymentIntent: z.string().trim().min(1).max(80) })

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

/** Dev only: `POST /mock-payments/dev/disputes { paymentIntent }` opens a dispute and fires its webhook. */
export async function action({ request }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	const { paymentIntent } = await readDevBody(request, schema)
	const emulator = getPaymentsEmulator()
	const intent = (await emulator.object('stripe', paymentIntent)) as Record<
		string,
		unknown
	> | null
	if (!intent || intent.type !== 'payment_intent' || !intent.latest_charge) {
		return Response.json({ error: 'payment_not_found' }, { status: 404 })
	}
	const dispute = await emulator.testing.createDispute(paymentIntent)
	return Response.json(dispute, { headers: noStore })
}

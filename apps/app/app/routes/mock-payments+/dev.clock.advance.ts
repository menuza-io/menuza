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
	seconds: z
		.number()
		.int()
		.min(1)
		.max(60 * 60 * 24 * 30),
})

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

/**
 * Dev only: `POST /mock-payments/dev/clock/advance { seconds }` moves mock time
 * forward (session expiry, pending refunds, idempotency retention).
 */
export async function action({ request }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	const { seconds } = await readDevBody(request, schema)
	const offsetMs = await getPaymentsEmulator().testing.advanceClock(seconds)
	return Response.json({ offsetMs }, { headers: noStore })
}

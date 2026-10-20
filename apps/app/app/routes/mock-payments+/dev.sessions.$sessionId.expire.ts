import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	gateDevApi,
	methodNotAllowed,
	noStore,
} from '#app/utils/payments-mock/dev-api.server.ts'
import { getPaymentsEmulator } from '#app/utils/payments-mock/emulator.server.ts'

export function loader({ request }: LoaderFunctionArgs) {
	gateDevApi(request)
	return methodNotAllowed()
}

/**
 * Dev only: `POST /mock-payments/dev/sessions/:sessionId/expire` expires a
 * Stripe Checkout Session now instead of waiting 30 minutes.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	gateDevApi(request)
	if (request.method !== 'POST') return methodNotAllowed()
	const emulator = getPaymentsEmulator()
	const id = params.sessionId ?? ''
	if (!(await emulator.object('stripe', id))) {
		return Response.json({ error: 'session_not_found' }, { status: 404 })
	}
	try {
		const session = await emulator.testing.expireSession(id)
		return Response.json({ id, status: session.status }, { headers: noStore })
	} catch {
		return Response.json({ error: 'session_not_open' }, { status: 409 })
	}
}
